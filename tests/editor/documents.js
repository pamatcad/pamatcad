// Runs after the rectangle/output checks in Chromium and the native WKWebView.
async function testDocumentEditor() {
  const find = (id) => document.getElementById(id);
  const tabs = () => [...find("document-tabs").querySelectorAll('button[role="tab"]')];
  const active = () => tabs().find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.document;
  const tabFor = (id) => tabs().find((tab) => tab.dataset.document === id);
  const check = (condition, reason) => { if (!condition) throw new Error(reason); };
  const wait = async (condition, reason) => {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > 60000) throw new Error(reason + ": " + find("status")?.textContent);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const change = (id, value) => {
    find(id).value = value;
    find(id).dispatchEvent(new Event("input", { bubbles: true }));
  };
  const create = async (button = "menu-new") => {
    const before = tabs().length;
    const previous = active();
    await wait(() => !find(button).disabled, "Enable New scene");
    find(button).click();
    await wait(() => tabs().length === before + 1 && active() !== previous && !find("menu-new").disabled,
      "Create document tab");
    const names = tabs().map((tab) => tab.textContent);
    check(new Set(names).size === names.length, "Document titles should be distinct");
    return active();
  };
  const activate = async (id) => {
    await wait(() => tabFor(id) && !tabFor(id).disabled, "Enable document switch");
    tabFor(id).click();
    await wait(() => active() === id && !find("menu-new").disabled, "Switch document");
  };
  const run = async (source, marker) => {
    await wait(() => !find("js").disabled, "Enable document console");
    const count = find("console-output").children.length;
    find("js").value = source;
    find("console-form").requestSubmit();
    await wait(() => !find("js").disabled && find("console-output").children.length > count + 1 &&
      find("console-output").lastElementChild.textContent.includes(marker), "Run document console");
    return find("console-output").lastElementChild.textContent;
  };
  const close = async (id) => {
    await wait(() => tabFor(id) && !tabFor(id).disabled, "Enable document close");
    tabFor(id).parentElement.querySelector(".close-document").click();
    await wait(() => !tabFor(id) && !find("menu-new").disabled, "Close document");
  };
  const originalConfirm = window.confirm;
  const originalAlert = window.alert;
  try {
    await wait(() => !find("new-sketch").disabled, "Ready for document checks");
    check(find("loading-screen").hidden && !document.body.hasAttribute("data-loading"),
      "Loading screen should finish after editor initialization");
    let homeMessage;
    window.alert = (message) => { homeMessage = message; };
    find("document-home").click();
    check(homeMessage === "Not implemented", "Document Home should show its placeholder");

    find("menu-about").click();
    check(find("about").open, "About should open");
    check(find("about-versions").textContent.includes("PamatCAD") &&
      find("about-versions").textContent.includes("OCCT"), "About should include both versions");
    check(find("about").querySelector("a").href === "https://github.com/pamatcad/pamatcad",
      "About should link to the project");
    find("about").close();

    const originalDocuments = tabs().map((tab) => tab.dataset.document);
    const first = await create();
    check(find("features").children.length === 0, "New document should have no timeline entries");
    await run('return "first-document-history"', "first-document-history");
    const firstHistory = find("console-output").textContent;
    find("js").value = "unfinished first-document input";
    find("new-sketch").click();
    change("width", "12");
    change("height", "8");

    const second = await create();
    check(find("features").children.length === 0 && find("tool-panel").hidden,
      "New document should not inherit another document's sketch draft");
    check(find("js").value === "" && !find("console-output").textContent.includes("first-document-history"),
      "New document should have its own console");
    await run('return "second-document-history"', "second-document-history");
    find("js").value = "unfinished second-document input";
    find("new-sketch").click();
    change("width", "5");
    change("height", "7");
    find("apply").click();
    await wait(() => find("features").children.length === 1 && !find("extrude").disabled,
      "Commit second document's sketch");
    find("extrude").click();
    change("length", "9 / 3");
    await wait(() => find("apply") && !find("apply").disabled, "Preview second document's extrusion");

    await activate(first);
    check(find("width")?.value === "12" && find("height")?.value === "8",
      "Restore first document's sketch draft");
    check(find("features").children.length === 0, "Sketch draft should not commit when switching tabs");
    check(find("js").value === "unfinished first-document input" &&
      find("console-output").textContent === firstHistory, "Restore first document's console draft and history");
    tabFor(first).focus();
    tabFor(first).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    check(active() === second && document.activeElement?.dataset.document === second,
      "Keyboard document switching should move focus to the newly active tab");
    await activate(first);
    change("width", "0");
    await activate(second);
    await activate(first);
    check(find("width").value === "0" && find("apply").disabled,
      "Returning to an invalid sketch draft must keep Finish disabled");
    change("width", "12");
    find("apply").click();
    await wait(() => !find("extrude").disabled, "Commit first document's sketch");
    find("extrude").click();
    change("length", "4");
    await wait(() => !find("apply").disabled, "Preview first document's extrusion");
    find("apply").click();
    await wait(() => find("features").children.length === 2 && !find("js").disabled,
      "Commit first document's extrusion");

    await activate(second);
    check(find("length")?.value === "9 / 3" && find("features").children.length === 1,
      "Restore second document's uncommitted extrusion");
    check(find("js").value === "unfinished second-document input" &&
      find("console-output").textContent.includes("second-document-history") &&
      !find("console-output").textContent.includes("first-document-history"),
      "Restore second document's isolated console");
    await wait(() => !find("apply").disabled, "Restore second document's preview");
    find("apply").click();
    await wait(() => find("features").children.length === 2 && !find("js").disabled,
      "Commit second document's extrusion");
    const secondGeometry = JSON.parse(await run(`const bodies = await scene.bodies.all();
      return {marker: "second-geometry", scene: scene.id, bodies: bodies.length,
        volume: (await (await scene.bodies.get(bodies[0].id)).properties()).volume.value};`, "second-geometry"));
    check(secondGeometry.scene === second && secondGeometry.bodies === 1 &&
      Math.abs(secondGeometry.volume - 105) < 1e-7, "Second document should contain its own extrusion");

    await activate(first);
    const firstGeometry = JSON.parse(await run(`const bodies = await scene.bodies.all();
      return {marker: "first-geometry", scene: scene.id, bodies: bodies.length,
        volume: (await (await scene.bodies.get(bodies[0].id)).properties()).volume.value};`, "first-geometry"));
    check(firstGeometry.scene === first && firstGeometry.bodies === 1 &&
      Math.abs(firstGeometry.volume - 384) < 1e-7, "First document should retain its own extrusion");

    let confirmations = 0;
    window.confirm = () => { confirmations++; return false; };
    tabFor(first).parentElement.querySelector(".close-document").click();
    await wait(() => confirmations === 1, "Confirm closing a populated document");
    check(tabFor(first) && active() === first && find("features").children.length === 2,
      "Canceling close should preserve the document");

    // All documents in this fixture are disposable test scenes.
    window.confirm = () => true;
    await close(second);
    check(active() === first && find("features").children.length === 2,
      "Closing an inactive tab should preserve the active document");
    await close(first);
    check(originalDocuments.includes(active()), "Closing the active tab should select a remaining document");
    for (const id of originalDocuments) await close(id);
    check(tabs().length === 0 && !find("empty-document").hidden && find("new-sketch").disabled && find("js").disabled,
      "Closing the last tab should leave an empty editor with modeling disabled");
    await create("empty-new-scene");
    check(tabs().length === 1 && find("features").children.length === 0 && !find("new-sketch").disabled,
      "Create a fresh scene after closing every tab");
    return { documents: "passed", volumes: [firstGeometry.volume, secondGeometry.volume] };
  } finally {
    window.confirm = originalConfirm;
    window.alert = originalAlert;
  }
}
