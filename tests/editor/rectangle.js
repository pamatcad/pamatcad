// Runs unchanged in Chromium and the desktop app's WKWebView.
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
  for (const selector of [".wordmark", "#extrude img"]) {
    await document.querySelector(selector).decode();
  }
  click("new-sketch");
  change("width", "10");
  change("height", "10");
  click("apply");
  await wait(() => !find("extrude").disabled, "Finish sketch");
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
  return result;
}
