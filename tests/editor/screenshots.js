// The same PNG assertions run in Chromium and the native WKWebView.
async function testScreenshotEditor() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = async (condition, message) => {
    const deadline = Date.now() + 60000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(message + ": " + document.getElementById("status").textContent);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const anchorClick = HTMLAnchorElement.prototype.click;
  const toBlob = HTMLCanvasElement.prototype.toBlob;
  const internals = window.__TAURI_INTERNALS__;
  let saved, failEncoding = false;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download.endsWith(".png")) anchorClick.call(this);
  };
  HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
    if (failEncoding) { callback(null); return; }
    return toBlob.call(this, blob => {
      saved = Promise.resolve(blob);
      callback(blob);
    }, ...args);
  };
  const capture = async mode => {
    saved = undefined;
    const button = document.querySelector(`[data-action="screenshot-${mode}"]`);
    button.click();
    await wait(() => saved && !button.disabled, "Save " + mode);
    const blob = await saved;
    if (!blob) return;
    const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    check(String(signature) === "137,80,78,71,13,10,26,10", "PNG signature");
    const image = new Image(), url = URL.createObjectURL(blob);
    try {
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return { canvas, context, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    } finally { URL.revokeObjectURL(url); }
  };
  const difference = (a, b, box) => {
    let count = 0;
    const [x, y, width, height] = box.map(value => Math.floor(value * devicePixelRatio));
    for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) {
      const offset = (row * a.canvas.width + col) * 4;
      if (Math.abs(a.data[offset] - b.data[offset]) + Math.abs(a.data[offset + 1] - b.data[offset + 1]) +
        Math.abs(a.data[offset + 2] - b.data[offset + 2]) > 30) count++;
    }
    return count;
  };
  try {
    check([...document.querySelectorAll('#web-menu > details > summary')].map(node => node.textContent).join() === "File,Tools,Help", "Web menu order");
    document.getElementById("sketches-tab").click();
    [...document.querySelectorAll('#object-list .tree-label')].find(node => node.textContent === "Sketch 1").click();
    document.getElementById("extrude").click();
    const lengthInput = document.getElementById("length");
    lengthInput.value = "25";
    lengthInput.dispatchEvent(new Event("input", { bubbles: true }));
    const operation = document.getElementById("extrude-mode");
    operation.value = "newBody";
    operation.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(() => document.getElementById("apply") && !document.getElementById("apply").disabled, "Extrusion preview");
    const length = document.getElementById("length").value;
    const timeline = document.getElementById("features").innerHTML;
    const viewport = document.getElementById("viewport").getBoundingClientRect();
    const clean = await capture("viewport");
    const ui = await capture("viewport-ui");
    const app = await capture("app");
    window.screenshotTestImages = { clean: clean.canvas.toDataURL(), ui: ui.canvas.toDataURL(), app: app.canvas.toDataURL() };
    const tabbar = document.querySelector(".document-bar").getBoundingClientRect();
    const footer = document.querySelector("footer").getBoundingClientRect();
    for (const shot of [clean, ui]) {
      check(shot.canvas.width === Math.floor(viewport.width * devicePixelRatio) &&
        shot.canvas.height === Math.floor(viewport.height * devicePixelRatio), "Native viewport PNG dimensions");
    }
    check(app.canvas.width === Math.floor(tabbar.width * devicePixelRatio) &&
      app.canvas.height === Math.floor((footer.bottom - tabbar.top) * devicePixelRatio), "Full app bounds exclude menu/header");
    let shaded = 0;
    for (let i = 0; i < clean.data.length; i += 4) {
      if (clean.data[i] < 225 && clean.data[i + 1] < 225 && clean.data[i + 2] < 225 && clean.data[i + 3] === 255) shaded++;
    }
    check(shaded > clean.canvas.width * clean.canvas.height * 0.01, "PNG should contain rendered geometry: " + shaded);
    check(difference(clean, ui, [viewport.width - 110, 10, 100, 100]) > 100, "UI PNG includes navigation cube");
    const panel = document.getElementById("tool-panel").getBoundingClientRect();
    check(difference(clean, ui, [panel.left - viewport.left + 4, panel.top - viewport.top + 4,
      Math.min(panel.width - 8, 200), Math.min(panel.height - 8, viewport.bottom - panel.top - 4)]) > 100, "UI PNG includes tool dialog");
    // A geometry-only patch must be identical in the canvas and the DOM-composited PNG.
    check(difference(clean, ui, [viewport.width / 4, viewport.height / 2, 30, 30]) === 0, "HTML capture preserves WebGL pixels");
    const restored = await capture("viewport");
    check(difference(clean, restored, [0, 0, viewport.width, viewport.height]) === 0, "Capture restores viewport rendering");
    check(document.getElementById("length").value === length && document.getElementById("features").innerHTML === timeline,
      "Capture preserves active tool input and geometry");
    failEncoding = true;
    document.querySelector('[data-action="screenshot-viewport"]').click();
    await wait(() => document.getElementById("status").textContent.includes("Could not encode the screenshot"), "Report capture error");
    await wait(() => !document.querySelector('[data-action="screenshot-viewport"]').disabled, "Re-enable capture after failure");
    failEncoding = false;
    if (internals) {
      await internals.invoke("save_screenshot", { filename: "invalid.png", bytes: [0] }).then(
        () => { throw new Error("Native save accepted invalid PNG bytes"); },
        error => check(String(error).includes("not a PNG"), "Reject invalid PNG"));
    }
    document.getElementById("cancel").click();
    // UI-free capture also retains the visible sketch geometry and annotations.
    document.getElementById("sketches-tab").click();
    const sketchLabel = [...document.querySelectorAll('#object-list .tree-label')].find(node => node.textContent === "Sketch 1");
    sketchLabel.click();
    sketchLabel.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await wait(() => document.getElementById("workbench").value === "sketch", "Edit sketch for capture");
    const sketch = await capture("viewport");
    check(sketch.canvas.width === clean.canvas.width, "Sketch PNG keeps viewport resolution");
    const sketchUi = await capture("viewport-ui");
    check(difference(sketch, sketchUi, [viewport.width - 110, 10, 100, 100]) > 100, "Sketch capture includes UI");
    document.getElementById("cancel").click();
    await wait(() => document.getElementById("tool-panel").hidden && !document.getElementById("js").disabled, "Finish capture fixtures");
    document.getElementById("bodies-tab").click();
    return { density: devicePixelRatio, viewport: [clean.canvas.width, clean.canvas.height], app: [app.canvas.width, app.canvas.height] };
  } finally {
    HTMLAnchorElement.prototype.click = anchorClick;
    HTMLCanvasElement.prototype.toBlob = toBlob;
  }
}
