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
  const form = panel.querySelector("#console-form");
  const runButton = form.querySelector("button");
  const wait = async (check, reason) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > 10000) throw new Error(reason + ": " + document.querySelector("#status").textContent);
      await new Promise((ok) => setTimeout(ok, 30));
    }
  };
  const check = (value, reason) => { if (!value) throw new Error(reason); };
  const timed = (row) => /^\d+\.\d ms$/.test(row.querySelector(".command-duration")?.textContent ?? "");
  const lastCommand = (method) => [...panel.querySelectorAll("#log details")].findLast((row) =>
    row.querySelector(".command-name")?.textContent === method);
  const checkTimings = () => {
    const rows = [...panel.querySelectorAll("#log details")];
    check(rows.length && rows.every(timed), "Completed commands should have elapsed milliseconds");
    const title = rows.at(-1).querySelector("summary");
    const duration = title.querySelector(".command-duration");
    check(Math.abs(title.getBoundingClientRect().right - duration.getBoundingClientRect().right) < 1,
      "Command times should align with the right edge of the log");
  };
  async function stopScript(source) {
    const features = document.querySelector("#features").children.length;
    const logs = panel.querySelector("#log").children.length;
    js.value = "scene.bodies.all();\n" + source;
    form.requestSubmit();
    await wait(() => panel.querySelector("#log").children.length > logs && runButton.textContent === "Stop",
      "Start nonterminating script");
    check(js.disabled && !runButton.disabled, "Keep Stop available while the console runs");
    runButton.click();
    await wait(() => !js.disabled, "Stop script without reloading");
    check(runButton.textContent === "Run" && output.lastElementChild.textContent === "Script stopped",
      "Report cancellation and restore Run");
    check(!document.querySelector("#new-sketch").disabled && !document.querySelector("#menu-new").disabled &&
      [...document.querySelectorAll('#document-tabs [role="tab"]')].every(tab => !tab.disabled),
      "Restore editing and document controls");
    check(document.querySelector("#features").children.length === features, "Preserve completed edits");
    js.value = 'return "Recovered: " + (await scene.bodies.all()).length';
    form.requestSubmit();
    await wait(() => !js.disabled && output.lastElementChild.textContent === "Recovered: 1", "Run another script");
  }
  const viewportHeight = () => document.querySelector("#viewport").clientHeight;
  const docked = () => panel.ownerDocument === document && !panel.hidden && toggle.getAttribute("aria-expanded") === "true";
  const expanded = viewportHeight();
  toggle.click();
  check(panel.hidden && viewportHeight() > expanded, "Collapse should give space to the viewport");
  toggle.click();

  for (const source of ["while (true) {}", "await new Promise(() => {})"]) await stopScript(source);
  js.value = 'await scene.evaluateFormula("1 / 0", {expectedDimension: "length"})';
  form.requestSubmit();
  await wait(() => !js.disabled && output.lastElementChild.textContent.includes("Division by zero"), "Log a failed command");
  check(timed(lastCommand("scene.evaluateFormula")), "Failed commands should also have elapsed time");
  const history = output.textContent;
  js.value = "return await scene.bodies.all()";
  const logTab = panel.querySelector('[data-dock="log"]');
  logTab.click();
  checkTimings();
  await popOut();
  await wait(() => panel.ownerDocument !== document, "Open output window");
  const popup = panel.ownerDocument.defaultView;
  check(popup.opener === window && !popup.document.querySelector("#model-canvas"), "Expected a separate output-only window");
  await wait(() => popup.getComputedStyle(panel).flexDirection === "column" &&
    panel.clientHeight === popup.document.documentElement.clientHeight, "Detached panel should fill its window");
  check(logTab.getAttribute("aria-selected") === "true" && !panel.querySelector("#log").hidden, "Keep selected tab");
  check(js.value === "return await scene.bodies.all()" && output.textContent === history, "Keep draft and history");
  check(viewportHeight() > expanded, "Detached dock should give space to the viewport");
  checkTimings();

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

  for (const source of ["while (true) {}", "await new Promise(() => {})"]) await stopScript(source);
  if (!window.__TAURI_INTERNALS__) {
    // Hold one CAD dispatch to verify Stop waits before refreshing or enabling another edit.
    const post = Worker.prototype.postMessage;
    let release;
    Worker.prototype.postMessage = function (data, ...args) {
      if (data?.request?.method === "sketch.complete") {
        release = () => post.call(this, data, ...args);
        return;
      }
      return post.call(this, data, ...args);
    };
    try {
      const before = document.querySelector("#features").children.length;
      js.value = `const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
        await sketch.primitives.add("rectangle", {from: [30, 30], to: [32, 32]});
        await Promise.all([sketch.complete(), scene.evaluateFormula("12 / 3", {expectedDimension: "length"})]); while (true) {}`;
      form.requestSubmit();
      await wait(() => release, "Dispatch pending model edit");
      const held = lastCommand("sketch.complete");
      const heldAt = performance.now();
      check(held.querySelector(".command-duration").textContent === "…", "Keep an unfinished command pending");
      await wait(() => {
        const row = lastCommand("scene.evaluateFormula");
        return row?.querySelector("pre").textContent.includes("12 / 3") && timed(row);
      }, "Complete another request while the edit is held");
      check(held.querySelector(".command-duration").textContent === "…", "Associate completion with its own command row");
      const logs = panel.querySelector("#log").children.length;
      runButton.click();
      await wait(() => runButton.textContent === "Run", "Terminate console worker");
      check(js.disabled && runButton.disabled && document.querySelector("#new-sketch").disabled,
        "Keep editing disabled until the pending CAD command finishes");
      check(panel.querySelector("#log").children.length === logs, "Wait before refreshing the scene");
      await new Promise((ok) => setTimeout(ok, 100));
      const heldFor = performance.now() - heldAt;
      release();
      release = undefined;
      await wait(() => !js.disabled, "Finish pending edit and recover");
      check(document.querySelector("#features").children.length === before + 1,
        "Keep the model edit dispatched before Stop");
      check(output.lastElementChild.textContent === "Script stopped", "Report cancellation after pending work");
      check(timed(held) && parseFloat(held.querySelector(".command-duration").textContent) >= heldFor - 1,
        "Elapsed command time should include queueing and dispatch delays");
    } finally {
      Worker.prototype.postMessage = post;
      release?.();
    }
    await stopScript("await new Promise(() => {})");
  }

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
  logTab.click();
  checkTimings();
  panel.querySelector('[data-dock="console"]').click();
  js.value = "";
}
