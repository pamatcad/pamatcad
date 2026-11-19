// Exercise the same panel inside the browser popup and the native webview window.
async function testOutputDock() {
  const panel = document.querySelector("#output-dock");
  const toggle = document.querySelector("#toggle-output");
  const location = panel.querySelector("#dock-location");
  const popOut = () => window.__TAURI_INTERNALS__
    ? window.__TAURI_INTERNALS__.invoke("click_pop_out")
    : location.click();
  const js = panel.querySelector("#js");
  const output = panel.querySelector("#console-output");
  const wait = async (check, reason) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > 10000) throw new Error(reason + ": " + document.querySelector("#status").textContent);
      await new Promise((ok) => setTimeout(ok, 30));
    }
  };
  const check = (value, reason) => { if (!value) throw new Error(reason); };
  const viewportHeight = () => document.querySelector("#viewport").clientHeight;
  const docked = () => panel.ownerDocument === document && !panel.hidden && toggle.getAttribute("aria-expanded") === "true";
  const expanded = viewportHeight();
  toggle.click();
  check(panel.hidden && viewportHeight() > expanded, "Collapse should give space to the viewport");
  toggle.click();

  const history = output.textContent;
  js.value = "return await scene.bodies.all()";
  const logTab = panel.querySelector('[data-dock="log"]');
  logTab.click();
  await popOut();
  await wait(() => panel.ownerDocument !== document, "Open output window");
  const popup = panel.ownerDocument.defaultView;
  check(popup.opener === window && !popup.document.querySelector("#model-canvas"), "Expected a separate output-only window");
  await wait(() => popup.getComputedStyle(panel).flexDirection === "column" &&
    panel.clientHeight === popup.document.documentElement.clientHeight, "Detached panel should fill its window");
  check(logTab.getAttribute("aria-selected") === "true" && !panel.querySelector("#log").hidden, "Keep selected tab");
  check(js.value === "return await scene.bodies.all()" && output.textContent === history, "Keep draft and history");
  check(viewportHeight() > expanded, "Detached dock should give space to the viewport");

  const count = document.querySelector("#features").children.length;
  const oldLogs = panel.querySelector("#log").children.length;
  panel.querySelector('[data-dock="console"]').click();
  js.value = `const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    await sketch.primitives.add("rectangle", {from: [20, 20], to: [25, 25]});
    await sketch.complete(); return "Detached sketch complete";`;
  panel.querySelector("#console-form").requestSubmit();
  await wait(() => document.querySelector("#features").children.length === count + 1 && !js.disabled,
    "Detached command should update main scene");
  check(output.lastElementChild.textContent.includes("Detached sketch complete"), "Detached command result");
  check(panel.querySelector("#log").children.length > oldLogs, "Live CAD log");
  check(panel.querySelector("#tree").textContent.includes("Sketches (2)"), "Live scene tree");

  js.value = "unfinished input";
  const treeTab = panel.querySelector('[data-dock="tree"]');
  treeTab.click();
  location.click();
  await wait(docked, "Dock back into editor");
  check(treeTab.getAttribute("aria-selected") === "true" && js.value === "unfinished input", "Keep tab and input on return");
  check(output.textContent.startsWith(history) && viewportHeight() === expanded, "Restore history and layout");
  await wait(() => popup.closed, "Close detached window when docking");

  await popOut();
  await wait(() => panel.ownerDocument !== document, "Reopen output window");
  if (window.__TAURI_INTERNALS__) await window.__TAURI_INTERNALS__.invoke("close_output");
  else panel.ownerDocument.defaultView.close();
  await wait(docked, "Return dock when its window closes");
  check(js.value === "unfinished input", "Preserve input on window close");
  panel.querySelector('[data-dock="console"]').click();
  js.value = "";
}
