import assert from "node:assert/strict";

export async function testSceneBrowser(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.addScriptTag({ path: "tests/editor/rectangle.js" });
    await page.evaluate(() => testRectangleEditor());
    await page.locator("#toggle-output").click();
    await page.locator("#home").click();

    const canvas = page.locator("#model-canvas");
    const tree = page.locator("#object-list");
    const row = (name) => tree.getByRole("button", { name, exact: true });
    const rootVisibility = () => tree.locator(":scope > li > .scene-tree-row > .tree-visibility");
    const clickCenter = async () => {
      const bounds = await canvas.boundingBox();
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    };
    const tab = async (name) => page.locator("#browser-tabs").getByRole("tab", { name, exact: true }).click();

    // Applying Extrude already hides its source sketch and clears the selection.
    assert.equal(await row("Body 1").getAttribute("aria-pressed"), "false");
    await tab("Sketches");
    assert.equal(await row("Show Sketch 1").getAttribute("aria-pressed"), "false");
    await tab("Bodies");
    await clickCenter();
    assert.match(await page.locator("#status").textContent(), /^(Face|Edge) selected$/);
    assert.equal(await row("Body 1").getAttribute("aria-pressed"), "true");
    const solid = await canvas.screenshot();
    await row("Hide Body 1").click();
    const hidden = await canvas.screenshot();
    assert.ok(!solid.equals(hidden), "Hiding a body must change the rendered model");
    await clickCenter();
    assert.equal(await page.locator("#status").textContent(), "Ready", "Hidden bodies must not be pickable");
    assert.equal(await row("Body 1").getAttribute("aria-pressed"), "false");
    await row("Show Body 1").click();
    await clickCenter();
    assert.match(await page.locator("#status").textContent(), /^(Face|Edge) selected$/);
    assert.ok(!(await canvas.screenshot()).equals(hidden), "Showing a body must restore its rendering");

    await rootVisibility().click();
    assert.equal(await row("Show Body 1").getAttribute("aria-pressed"), "false", "Scene visibility propagates to bodies");
    await clickCenter();
    assert.equal(await page.locator("#status").textContent(), "Ready");
    await rootVisibility().click();
    assert.equal(await row("Hide Body 1").getAttribute("aria-pressed"), "true");
    await clickCenter();
    assert.match(await page.locator("#status").textContent(), /^(Face|Edge) selected$/);
    await row("Hide Body 1").click();

    await tab("Construction");
    const origin = tree.getByRole("treeitem", { name: "Origin", exact: true });
    assert.equal(await origin.locator(":scope > ul[role=group] > li").count(), 3);
    const originBounds = await row("Origin").boundingBox();
    const planeBounds = await row("XY plane").boundingBox();
    assert.ok(planeBounds.x > originBounds.x, "Construction planes must be visibly nested under Origin");
    const withoutPlanes = await canvas.screenshot();
    await row("Show Origin").click();
    for (const name of ["XY plane", "XZ plane", "YZ plane"]) {
      assert.equal(await row("Hide " + name).getAttribute("aria-pressed"), "true");
    }
    assert.ok(!(await canvas.screenshot()).equals(withoutPlanes), "Showing Origin must render its planes");
    await row("Hide Origin").click();
    for (const name of ["XY plane", "XZ plane", "YZ plane"]) {
      assert.equal(await row("Show " + name).getAttribute("aria-pressed"), "false");
    }

    await row("Show XY plane").click();
    const plane = await canvas.screenshot();
    await row("XY plane").click();
    assert.equal(await page.locator("#status").textContent(), "Plane selected");
    assert.ok(!(await canvas.screenshot()).equals(plane), "Tree selection must highlight the visible plane");
    // The gizmo's Top face gives an unambiguous hit inside the XY plane.
    const bounds = await canvas.boundingBox();
    await page.mouse.click(bounds.x + bounds.width - 60, bounds.y + 38);
    await tab("Bodies");
    await clickCenter();
    assert.equal(await page.locator("#status").textContent(), "Plane selected");
    assert.equal(await page.locator("#construction-tab").getAttribute("aria-selected"), "true");
    assert.equal(await row("XY plane").getAttribute("aria-pressed"), "true", "Viewport selection must highlight the plane in the tree");
    await row("Hide XY plane").click();
    await clickCenter();
    assert.equal(await page.locator("#status").textContent(), "Ready", "Hidden planes must not be pickable");

    await row("Collapse Origin").click();
    const resize = page.locator("#browser-resize");
    await resize.focus();
    for (let step = 0; step < 8; step++) await page.keyboard.press("ArrowRight");
    const savedWidth = await resize.getAttribute("aria-valuenow");
    assert.ok(Number(savedWidth) > 220);
    await page.locator("#toggle-browser").click();
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#new-sketch") && !document.querySelector("#new-sketch").disabled);
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#toggle-browser").getAttribute("aria-expanded"), "false", "Browser collapse must survive reload");
    assert.equal(await resize.getAttribute("aria-valuenow"), savedWidth, "Browser width must survive reload");
    await page.locator("#toggle-browser").click();
    assert.equal(await page.locator("#construction-tab").getAttribute("aria-selected"), "true", "Active browser tab must survive reload");
    assert.equal(await origin.getAttribute("aria-expanded"), "false", "Origin expansion must survive reload");

    // Recreate geometry after reload; Reset UI must only affect its presentation.
    await page.addScriptTag({ path: "tests/editor/rectangle.js" });
    await page.evaluate(() => testRectangleEditor());
    await tab("Construction");
    assert.equal(await origin.getAttribute("aria-expanded"), "false");
    await page.locator("#toggle-browser").click();
    await page.locator("#web-menu").getByText("Help", { exact: true }).click();
    await page.getByRole("button", { name: "Reset UI", exact: true }).click();
    assert.equal(await page.locator("#toggle-browser").getAttribute("aria-expanded"), "true");
    assert.equal(await resize.getAttribute("aria-valuenow"), "220");
    assert.equal(await page.locator("#bodies-tab").getAttribute("aria-selected"), "true");
    assert.equal(await tree.locator(".object-row").count(), 1, "Reset UI must preserve the current body");
    assert.equal(await page.locator("#features li").count(), 2, "Reset UI must preserve the current timeline");
    await tab("Construction");
    assert.equal(await origin.getAttribute("aria-expanded"), "true", "Reset UI must restore expanded branches");

    if (!await page.locator("#output-dock").isVisible()) await page.locator("#toggle-output").click();
    await page.locator("#js").fill(`const bodies = await scene.bodies.all();
      return { bodies: bodies.length, preservedVolume: (await (await scene.bodies.get(bodies[0].id)).properties()).volume.value };`);
    await page.locator("#js").press("Enter");
    await page.waitForFunction(() => document.querySelector("#console-output").lastElementChild?.textContent.includes('"preservedVolume"') && !document.querySelector("#js").disabled);
    const result = JSON.parse(await page.locator("#console-output > :last-child").textContent());
    assert.deepEqual(result, { bodies: 1, preservedVolume: 1500 });
    assert.deepEqual(errors, []);
    console.log("Scene tree nesting, visibility, viewport picking, persisted layout, and Reset UI preservation passed");
  } finally {
    await context.close();
  }
}
