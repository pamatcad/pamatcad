import assert from "node:assert/strict";

export async function testSketchAppearance(page) {
  await page.getByText("File", { exact: true }).click();
  await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled && !document.querySelector("#features").children.length);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts"), start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) { window.appearanceCheck = { tool: this, viewport: this.viewport }; return start.apply(this, args); };
    try { document.querySelector("#new-sketch").click(); } finally { SketchTool.prototype.start = start; }
  });
  await page.evaluate(() => chooseSketchPlane("XY"));
  await page.waitForFunction(() => window.appearanceCheck?.tool.state && !window.appearanceCheck.tool.pending);
  try {
    const noHighlight = page.getByRole("button", { name: "No highlight", exact: true });
    assert.equal(await noHighlight.getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => window.appearanceCheck.tool.options.highlight), "none");
    const result = await page.evaluate(async () => {
      const { tool, viewport } = window.appearanceCheck, s = tool.sketch;
      const selected = await s.primitives.add("circle", { center: [-20, 0], diameter: 10 });
      const free = await s.primitives.add("line", { from: [-35, -25], to: [-22, -12] });
      const partial = await s.primitives.add("line", { from: [-25, 15], to: [-10, 15] });
      await s.constraints.add("horizontal", { curves: partial.curves });
      const constrained = await s.primitives.add("circle", { center: [12, 0], diameter: 10 });
      await s.constraints.add("fix", { points: constrained.points });
      const dimension = await s.dimensions.add("radius", { curve: constrained.curves[0], value: 5, mode: "driving", annotation: { position: [16, 9] } });
      const fixed = await s.primitives.add("line", { from: [-10, -15], to: [10, -15] });
      await s.constraints.add("fix", { curves: fixed.curves });
      await tool.reload(); tool.choose("select");
      tool.selected.add(selected.curves[0].id); tool.selected.add(selected.points[0].id); tool.selectionChanged();
      const { editorTheme, lightTheme } = await import("/src/theme.ts");
      const display = viewport.sketchDisplay;
      const curve = ref => display.children.find(c => c.userData.pick?.id === ref.id && c.isLine);
      const point = ref => display.children.find(c => c.userData.pick?.id === ref.id && c.isPoints);
      const colors = () => [selected, free, partial, constrained, fixed].map(g => curve(g.curves[0]).material.color.getHexString());
      const initial = colors(), normal = curve(free.curves[0]), picked = curve(selected.curves[0]);
      const wide = display.children.find(c => c.isLineSegments2 && c.userData.pick.id === selected.curves[0].id);
      const thin = display.children.find(c => c.isLineSegments2 && c.userData.pick.id === free.curves[0].id), marker = point(selected.points[0]), ordinary = point(free.points[0]);
      const selection = { widths: [thin.material.linewidth, wide.material.linewidth], points: [ordinary.material.size, marker.material.size],
        lineAbove: picked.renderOrder > normal.renderOrder, pointAbove: marker.renderOrder > ordinary.renderOrder, pointsAboveLines: ordinary.renderOrder > picked.renderOrder,
        screenWidth: !wide.material.worldUnits, color: wide.material.color.getHexString() };
      const numeric = tool.state.dimensions.find(d => d.id === dimension.id);
      const { formatDimension } = await import("/src/sketch-dimensions.ts");
      const formats = [1.23456789, 10000.123456, 2, -0.00001, "12.3456789 mm", "2.3456789 rad", "1e-3 in", "width / 3", "20 / 2"].map(formatDimension);
      const labels = display.children.filter(c => c.isSprite && c.userData.pick?.kind === "dimension");
      const labelPixels = labels[0].material.map.image.getContext("2d").getImageData(0, 0, labels[0].material.map.image.width, 36).data;
      let darkPixels = 0;
      for (let i = 0; i < labelPixels.length; i += 4) if (labelPixels[i] < 30 && labelPixels[i + 1] < 30 && labelPixels[i + 2] < 30) darkPixels++;
      editorTheme.set({ ...lightTheme, colors: { ...lightTheme.colors, unconstrained: "#123456", partiallyConstrained: "#234567", constrained: "#345678", fixed: "#456789", geometrySelected: "#56789a" } });
      const themed = colors(); editorTheme.set(lightTheme);
      const withoutFreedom = { ...tool.state, status: { ...tool.state.status, entities: tool.state.status.entities.filter(e => e.entity.id !== constrained.curves[0].id) } };
      display.set(withoutFreedom, tool.proxy, tool.selected, tool.options, lightTheme);
      const missingFreedom = curve(constrained.curves[0]).material.color.getHexString();
      tool.display();
      // The region fill must not wash out selection colors rendered above it.
      viewport.render();
      const selectedPixel = await new Promise(resolve => requestAnimationFrame(() => {
        const snapshot = document.createElement("canvas"), canvas = viewport.renderer.domElement;
        snapshot.width = canvas.width; snapshot.height = canvas.height;
        const context = snapshot.getContext("2d"); context.drawImage(canvas, 0, 0);
        const position = tool.proxy.points.find(p => p.entity.id === selected.points[0].id).position;
        const projected = viewport.camera.position.clone().fromArray(position).project(viewport.camera);
        resolve([...context.getImageData(Math.floor((projected.x + 1) * canvas.width / 2), Math.floor((1 - projected.y) * canvas.height / 2), 1, 1).data]);
      }));
      // Display rounding must not feed back into an automatic drawing or handle value.
      tool.setNumericField("width", 12.345678901);
      const field = { text: tool.input("width").value, value: await tool.number("width") };
      const focus = ["input", "textarea", "select"].map(tag => {
        const input = document.createElement(tag); document.body.append(input); input.focus();
        const outline = getComputedStyle(input).outlineStyle; input.remove(); return outline;
      });
      window.appearanceCheck.refs = { selected, free, partial, constrained, fixed, dimension };
      return { initial, selection, themed, missingFreedom, formats, darkPixels, selectedPixel, field, focus, numeric: numeric.computed.value };
    });
    assert.deepEqual(result.initial, ["d55e00", "1565c0", "007c91", "000000", "7b3fb3"]);
    assert.deepEqual(result.themed, ["56789a", "123456", "234567", "345678", "456789"]);
    assert.deepEqual(result.selection.widths, [1, 2]); assert.deepEqual(result.selection.points, [7, 14]);
    assert.ok(result.selection.lineAbove && result.selection.pointAbove && result.selection.pointsAboveLines && result.selection.screenWidth);
    assert.equal(result.selection.color, "d55e00"); assert.equal(result.missingFreedom, "1565c0");
    assert.deepEqual(result.selectedPixel, [213, 94, 0, 255], "Selected geometry retains its color over the region fill");
    assert.deepEqual(result.formats, ["1.2346", "10000.1235", "2", "0", "12.3457 mm", "2.3457 rad", "0.001 in", "width / 3", "20 / 2"]);
    assert.ok(result.darkPixels > 20, "Dimension numerals have dark pixels on their white label background");
    assert.deepEqual(result.field, { text: "12.3457 mm", value: 12.345678901 });
    assert.deepEqual(result.focus, ["none", "none", "none"]);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: "/private/tmp/pamatcad-sketch-appearance.png" });
    await page.evaluate(() => {
      const { viewport } = window.appearanceCheck;
      window.appearanceCheck.pixelRatio = viewport.renderer.getPixelRatio();
      viewport.renderer.setPixelRatio(2); viewport.render();
    });
    await page.screenshot({ path: "/private/tmp/pamatcad-sketch-appearance-retina.png" });
    await page.evaluate(() => {
      const { viewport, pixelRatio } = window.appearanceCheck;
      viewport.renderer.setPixelRatio(pixelRatio); viewport.render();
    });
    const colors = () => page.evaluate(() => {
      const { refs, viewport } = window.appearanceCheck;
      const color = (ref, type) => viewport.sketchDisplay.children.find(c => c[type] && c.userData.pick?.id === ref.id).material.color.getHexString();
      return {
        curves: [refs.selected, refs.free, refs.partial, refs.constrained, refs.fixed].map(g => color(g.curves[0], "isLineSegments2")),
        points: [refs.selected, refs.free, refs.fixed].map(g => color(g.points[0], "isPoints")),
      };
    });
    const commands = await page.locator("#log summary").count();
    const normal = await colors();
    await page.getByRole("button", { name: "Unconstrained geometry", exact: true }).click();
    assert.deepEqual(await colors(), { curves: ["d55e00", "16a34a", "007c91", "000000", "7b3fb3"], points: ["d55e00", "16a34a", "7b3fb3"] });
    assert.equal(await noHighlight.getAttribute("aria-pressed"), "false");
    await page.getByRole("button", { name: "Constrained geometry", exact: true }).click();
    assert.deepEqual(await colors(), { curves: ["d55e00", "1565c0", "007c91", "16a34a", "16a34a"], points: ["d55e00", "1565c0", "16a34a"] });
    await page.screenshot({ path: "/private/tmp/pamatcad-sketch-highlight.png" });
    await page.evaluate(async () => {
      const { editorTheme, lightTheme } = await import("/src/theme.ts");
      editorTheme.set({ ...lightTheme, colors: { ...lightTheme.colors, geometryHighlight: "#a020c0" } });
    });
    assert.deepEqual(await colors(), { curves: ["d55e00", "1565c0", "007c91", "a020c0", "a020c0"], points: ["d55e00", "1565c0", "a020c0"] });
    await page.evaluate(async () => {
      const { editorTheme, lightTheme } = await import("/src/theme.ts"); editorTheme.set(lightTheme);
    });
    await page.getByRole("button", { name: "Partially constrained geometry", exact: true }).click();
    assert.deepEqual(await colors(), { curves: ["d55e00", "1565c0", "16a34a", "000000", "7b3fb3"], points: normal.points });
    assert.equal(await page.locator('#sketch-highlight [aria-pressed="true"]').count(), 1);
    await page.getByRole("button", { name: "Partially constrained geometry", exact: true }).click();
    assert.deepEqual(await colors(), normal);
    assert.equal(await noHighlight.getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Constrained geometry", exact: true }).click();
    await noHighlight.click();
    assert.deepEqual(await colors(), normal);
    assert.equal(await noHighlight.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#log summary").count(), commands, "Category highlighting and theme changes do not call the core");
    await page.locator("#apply").click();
    await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
    console.log("Sketch appearance: solved/free/fixed colors, category highlights and reset, selection priority, live theme, full-precision presentation, and focus styling passed");
  } finally { await page.evaluate(() => { delete window.appearanceCheck; }); }
}
