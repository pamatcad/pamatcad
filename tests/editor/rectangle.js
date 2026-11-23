// Runs unchanged in Chromium and the desktop app's WKWebView.
// Most workflows select through the scene browser; the plane interaction regression
// separately exercises real pointer picking, hover and sizing in the viewport.
async function chooseSketchPlane(name = "XY") {
  const idle = async () => {
    const deadline = Date.now() + 60000;
    while (!document.getElementById("progress").hidden) {
      if (Date.now() > deadline) throw new Error("Plane selection timed out");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await idle();
  const previous = document.querySelector('#browser-tabs [aria-selected="true"]');
  document.getElementById("construction-tab").click();
  const origin = document.querySelector('#object-list [role="treeitem"][aria-label="Origin"]');
  const collapsed = origin?.getAttribute("aria-expanded") === "false";
  if (collapsed) origin.querySelector(".tree-expand").click();
  const plane = [...document.querySelectorAll("#object-list .object-row")].find(b => b.textContent.trim() === name + " plane");
  if (!plane) throw new Error("Missing construction plane " + name);
  plane.click();
  await idle();
  if (collapsed) document.querySelector('#object-list [role="treeitem"][aria-label="Origin"] .tree-expand').click();
  previous?.click();
}

function beginRectangleDraft() {
  document.querySelector('#sketch-ribbon [data-tool="rectangle"]').click();
  const canvas = document.getElementById("model-canvas"), r = canvas.getBoundingClientRect();
  const pointer = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0, pointerId: 1, pointerType: "mouse", bubbles: true };
  // Synthetic DOM events have no native pointer to capture in WKWebView.
  const capture = canvas.setPointerCapture;
  canvas.setPointerCapture = () => {};
  try {
    canvas.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
    canvas.dispatchEvent(new PointerEvent("pointerup", pointer));
  } finally { canvas.setPointerCapture = capture; }
}

async function testRectangleEditor() {
  const find = (id) => document.getElementById(id);
  const wait = async (condition, step) => {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > 60000) throw new Error(step + " timed out: " + find("status")?.textContent);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const click = (id) => find(id).click();
  const change = (id, value) => {
    find(id).value = value;
    find(id).dispatchEvent(new Event("input", { bubbles: true }));
  };
  await wait(() => find("new-sketch") && !find("new-sketch").disabled, "Start engine");
  if (!find("output-dock").hidden) throw new Error("Output should start collapsed");
  await document.querySelector(".wordmark").decode();
  if (!document.querySelector("#extrude svg .icon-surface-fill")) throw new Error("Missing themed extrude icon");
  click("new-sketch");
  await wait(() => find("sketch-support"), "Show sketch planes");
  if (find("workbench").value !== "sketch" || find("sketch-ribbon").hidden) throw new Error("Expected the Sketch ribbon");
  await chooseSketchPlane();
  await wait(() => !find("apply").disabled, "Choose sketch plane");
  beginRectangleDraft();
  change("width", "10");
  change("height", "10");
  await wait(() => !find("apply").disabled, "Validate rectangle dimensions");
  click("apply");
  await wait(() => !find("extrude").disabled, "Finish sketch");
  if (find("workbench").value !== "solid" || find("solid-ribbon").hidden) throw new Error("Expected the Solid ribbon");
  click("extrude");
  change("length", "6 + 4");
  await wait(() => !find("apply").disabled, "Preview formula");
  if (find("features").children.length !== 1) throw new Error("Preview changed timeline");
  click("cancel");
  click("bodies-tab");
  if (find("object-list").querySelector(".object-row")) throw new Error("Preview created a body");
  click("extrude");
  change("length", "bad");
  await wait(() => !find("length").validity.valid && find("apply").disabled, "Reject invalid length");
  change("length", "15");
  await wait(() => !find("apply").disabled, "Preview 15 mm");
  click("apply");
  await wait(() => find("features").children.length === 2 && !find("js").disabled, "Commit extrusion");
  if (find("object-list").querySelectorAll(".object-row").length !== 1) throw new Error("Expected one body");
  click("toggle-output");
  find("js").value = `const refs = await scene.bodies.all();
    const b = await scene.bodies.get(refs[0].id);
    return {bodies: refs.length, timeline: (await scene.timeline.list()).map(f => f.type),
      volume: (await b.properties()).volume.value, triangles: (await scene.getProxyFor(refs[0])).triangles.length / 3};`;
  find("console-form").requestSubmit();
  await wait(
    () =>
      find("console-output").lastElementChild?.textContent.includes('"triangles"') && !find("js").disabled,
    "Read geometry in the console",
  );
  const result = JSON.parse(find("console-output").lastElementChild.textContent);
  if (
    result.bodies !== 1 ||
    result.timeline.join(",") !== "sketch,extrude" ||
    Math.abs(result.volume - 1500) > 1e-7 ||
    result.triangles !== 12
  ) {
    throw new Error("Unexpected rectangle extrusion: " + JSON.stringify(result));
  }
  let footprint = null;
  if (window.__TAURI_INTERNALS__) {
    footprint = await window.__TAURI_INTERNALS__.invoke("memory_footprint");
    if (footprint && !(footprint.bytes > 0 && footprint.processes >= 1)) {
      throw new Error("Invalid app memory footprint: " + JSON.stringify(footprint));
    }
  }
  await wait(
    () => footprint
      ? /^\d+\.\d{2} GB RAM$/.test(find("memory-footprint").textContent)
      : find("memory-footprint").textContent === "RAM unavailable",
    "Display app memory footprint",
  );
  return { ...result, footprint, memory: find("memory-footprint").textContent };
}
