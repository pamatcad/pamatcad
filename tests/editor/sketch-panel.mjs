import assert from "node:assert/strict";

export async function testSketchPanel(page) {
  await page.getByText("File", { exact: true }).click();
  await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled && !document.querySelector("#features").children.length);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts");
    const start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) {
      window.panelCheck = { tool: this, viewport: this.viewport, view: this.viewport.captureView() };
      return start.apply(this, args);
    };
    try { document.querySelector("#new-sketch").click(); }
    finally { SketchTool.prototype.start = start; }
  });
  const idle = () => page.waitForFunction(() => {
    const { tool, viewport } = window.panelCheck;
    return !viewport.renderPending && !tool.pending && !tool.updateRunning && !tool.creating;
  });
  const screen = point => page.evaluate(point => {
    const v = window.panelCheck.viewport, rect = document.querySelector("#model-canvas").getBoundingClientRect();
    const p = v.camera.position.clone().fromArray(point).project(v.camera);
    return [rect.x + (p.x + 1) * rect.width / 2, rect.y + (1 - p.y) * rect.height / 2];
  }, point);
  const planeInfo = () => page.evaluate(() => {
    const v = window.panelCheck.viewport;
    return v.construction.children.map(p => ({ id: p.userData.plane,
      center: p.getWorldPosition(p.position.clone()).toArray(), size: v.construction.scale.x,
      vertices: Array.from({ length: p.geometry.attributes.position.count }, (_, i) =>
        p.localToWorld(p.position.clone().fromBufferAttribute(p.geometry.attributes.position, i)).toArray()),
      label: p.children.find(c => c.isSprite).userData.planeLabel,
      fill: p.material.color.getHexString(), opacity: p.material.opacity,
      labelColor: p.children.find(c => c.isSprite).material.color.getHexString(),
      edge: p.children.find(c => c.isLine).material.color.getHexString(), hovered: p.userData.hovered,
    }));
  });
  try {
    await idle();
    assert.equal(await page.locator("#sketch-support").innerText(), "Choose a construction plane or a planar solid face");
    assert.equal(await page.locator("#sketch-name, #sketch-planes, #sketch-hint, #sketch-convert").count(), 0);
    assert.equal(await page.locator("#sketch-workspace").isVisible(), false);
    let planes = await planeInfo();
    assert.deepEqual(planes.map(p => p.label).sort(), ["XY", "XZ", "YZ"]);
    for (const plane of planes) {
      const axes = plane.label === "XY" ? [0, 1] : plane.label === "XZ" ? [0, 2] : [1, 2];
      for (const axis of axes) {
        assert.ok(Math.abs(Math.min(...plane.vertices.map(p => p[axis])) / plane.size - 1 / 8) < 1e-9);
        assert.ok(Math.abs(Math.max(...plane.vertices.map(p => p[axis])) / plane.size - 9 / 8) < 1e-9);
      }
      await page.mouse.move(...await screen(plane.center)); await idle();
      const hovered = (await planeInfo()).filter(p => p.hovered);
      assert.deepEqual(hovered.map(p => p.id), [plane.id], plane.label + " is pickable at its visible center");
      assert.notEqual(hovered[0].fill, plane.fill);
      assert.ok(hovered[0].opacity > plane.opacity);
    }
    await page.screenshot({ path: "/private/tmp/pamatcad-sketch-planes.png" });
    await page.evaluate(async () => {
      const { editorTheme } = await import("/src/theme.ts");
      window.panelCheck.theme = editorTheme.definition;
      editorTheme.set({ ...editorTheme.definition, colors: { ...editorTheme.definition.colors,
        construction: "#123456", constructionEdge: "#234567", selection: "#345678", highlight: "#456789", foreground: "#56789a" } });
    });
    await idle();
    planes = await planeInfo();
    assert.ok(planes.every(p => p.fill === (p.hovered ? "345678" : "123456")));
    assert.ok(planes.every(p => p.edge === (p.hovered ? "456789" : "234567")));
    assert.ok(planes.every(p => p.labelColor === (p.hovered ? "456789" : "56789a")));
    await page.mouse.move(5, 5); await idle();
    assert.ok((await planeInfo()).every(p => !p.hovered));
    await page.evaluate(async () => (await import("/src/theme.ts")).editorTheme.set(window.panelCheck.theme));

    // Measure projected corners, independently of the world-to-pixel sizing implementation.
    for (const mode of ["orthographic", "perspective"]) {
      for (const [width, height, zoom] of [[1280, 840, 1], [960, 1000, 2], [1440, 900, 0.5]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(({ mode, zoom }) => window.panelCheck.viewport.restoreView({
          mode, zoom, span: 60, position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0],
        }), { mode, zoom });
        await idle();
        const plane = (await planeInfo()).find(p => p.label === "XY"), rect = await page.locator("#model-canvas").boundingBox();
        const corners = await Promise.all(plane.vertices.map(screen));
        const side = Math.max(...corners.map(p => p[0])) - Math.min(...corners.map(p => p[0]));
        assert.ok(Math.abs(side - Math.min(rect.width, rect.height) / 8) < 1e-5, mode + " plane size follows viewport and zoom");
      }
    }
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.evaluate(() => window.panelCheck.viewport.restoreView(window.panelCheck.view)); await idle();
    await page.mouse.click(...await screen((await planeInfo()).find(p => p.label === "XY").center));
    await page.waitForFunction(() => !!window.panelCheck.tool.sketch && !document.querySelector("#apply").disabled);
    assert.equal(await page.locator("#sketch-recompute").isVisible(), false);
    assert.equal(await page.getByText("References", { exact: true }).count(), 0);
    for (const [name, count] of [["Geometry mode", 2], ["Display", 6], ["Snap", 2], ["Highlight", 4]]) {
      const controls = page.getByRole("group", { name, exact: true }).getByRole("button");
      assert.equal(await controls.count(), count);
      const bounds = await controls.evaluateAll(buttons => buttons.map(b => ({ top: b.getBoundingClientRect().top, title: b.title, mask: getComputedStyle(b.firstElementChild).maskImage })));
      assert.ok(bounds.every(b => b.top === bounds[0].top && b.title && b.mask !== "none"), name + " icons have tooltips and occupy one row");
    }
    const normal = page.getByRole("button", { name: "Normal geometry", exact: true });
    const construction = page.getByRole("button", { name: "Construction geometry", exact: true });
    await construction.click();
    assert.equal(await construction.getAttribute("aria-pressed"), "true");
    await page.locator('#sketch-ribbon [data-tool="line"]').click();
    await page.mouse.click(...await screen([-15, -10, 0]));
    await page.mouse.click(...await screen([-5, -10, 0])); await idle();
    assert.ok(await page.evaluate(() => window.panelCheck.tool.state.entities.some(e => e.geometry.type === "line" && e.construction)));
    await normal.click(); await idle();
    await page.evaluate(async () => {
      const t = window.panelCheck.tool;
      await t.sketch.primitives.add("line", { from: [-15, -15], to: [-5, -15] });
      await t.reload();
      t.selected.clear();
      for (const e of t.state.entities.filter(e => e.geometry.type === "line")) t.selected.add(e.reference.id);
      t.selectionChanged();
    });
    assert.equal(await normal.getAttribute("aria-pressed"), "false");
    assert.equal(await construction.getAttribute("aria-pressed"), "false", "Mixed geometry has no single mode");
    await construction.click(); await idle();
    assert.ok(await page.evaluate(() => window.panelCheck.tool.state.entities.filter(e => e.geometry.type === "line").every(e => e.construction)));
    await normal.click(); await idle();
    assert.ok(await page.evaluate(() => window.panelCheck.tool.state.entities.filter(e => e.geometry.type === "line").every(e => !e.construction)));
    await page.getByLabel("Recompute automatically").uncheck(); await idle();
    assert.equal(await page.locator("#sketch-recompute").isVisible(), true);
    await page.locator("#sketch-recompute").click(); await idle();
    await page.getByLabel("Recompute automatically").check(); await idle();
    assert.equal(await page.locator("#sketch-recompute").isVisible(), false);
    for (const name of ["Show lines", "Show points", "Show constraints", "Show dimensions", "Show construction", "Show projections", "Snap to geometry", "Snap to grid"]) {
      const button = page.getByRole("button", { name, exact: true }), before = await button.getAttribute("aria-pressed");
      await button.click(); assert.notEqual(await button.getAttribute("aria-pressed"), before);
    }
    await page.getByRole("button", { name: "Partially constrained geometry", exact: true }).click();
    assert.equal(await page.evaluate(() => window.panelCheck.tool.options.highlight), "partial");
    const controls = await page.locator(".sketch-icon-options button").evaluateAll(buttons => buttons.map(b => b.getAttribute("aria-pressed")));
    const documentId = await page.locator('#document-tabs [aria-selected="true"]').getAttribute("data-document");
    await page.getByText("File", { exact: true }).click(); await page.locator("#menu-new").click();
    await page.waitForFunction(id => document.querySelector('#document-tabs [aria-selected="true"]').getAttribute("data-document") !== id && !document.querySelector("#menu-new").disabled, documentId);
    await page.locator(`#document-tabs [data-document="${documentId}"]`).click(); await idle();
    assert.deepEqual(await page.locator(".sketch-icon-options button").evaluateAll(buttons => buttons.map(b => b.getAttribute("aria-pressed"))), controls);
    await page.screenshot({ path: "/private/tmp/pamatcad-sketch-panel.png" });
    await page.locator("#cancel").click();
    await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
    console.log("Sketch panel: plane hover, quadrant offsets, responsive sizing, palette, viewport selection, compact controls, construction conversion, recompute and tab preservation passed");
  } finally {
    await page.evaluate(async () => {
      if (window.panelCheck.theme) (await import("/src/theme.ts")).editorTheme.set(window.panelCheck.theme);
      delete window.panelCheck;
    });
  }
}
