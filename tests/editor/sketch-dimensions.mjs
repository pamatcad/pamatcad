import assert from "node:assert/strict";

export async function testSketchDimensions(page) {
  await page.getByText("File", { exact: true }).click();
  await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled && !document.querySelector("#features").children.length);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts");
    const start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) { window.dimensionCheck = { tool: this, viewport: this.viewport, calls: [] }; return start.apply(this, args); };
    try { document.querySelector("#new-sketch").click(); } finally { SketchTool.prototype.start = start; }
  });
  await page.evaluate(() => chooseSketchPlane("XY"));
  await page.waitForFunction(() => window.dimensionCheck?.tool.state && !window.dimensionCheck.tool.pending);
  const idle = () => page.waitForFunction(() => !window.dimensionCheck.tool.pending && !window.dimensionCheck.tool.updateRunning && !window.dimensionCheck.tool.dragQueued && !window.dimensionCheck.viewport.renderPending);
  const screen = xy => page.evaluate(xy => {
    const { tool, viewport } = window.dimensionCheck, frame = tool.state.frame;
    viewport.camera.updateMatrixWorld();
    const p = viewport.camera.position.clone().fromArray(frame.origin).addScaledVector(viewport.camera.position.clone().fromArray(frame.u), xy[0]).addScaledVector(viewport.camera.position.clone().fromArray(frame.v), xy[1]).project(viewport.camera);
    const r = document.querySelector("#model-canvas").getBoundingClientRect();
    return [r.x + (p.x + 1) * r.width / 2, r.y + (1 - p.y) * r.height / 2];
  }, xy);
  const near = (a, b, tolerance = 1e-6) => assert.ok(Math.hypot(...a.map((v, i) => v - b[i])) < tolerance, `${a} != ${b}`);
  try {
    const refs = await page.evaluate(async () => {
      const { tool } = window.dimensionCheck, s = tool.sketch;
      const circle = await s.primitives.add("circle", { center: [-18, 0], diameter: 10 });
      const line = await s.primitives.add("line", { from: [0, 0], to: [15, 0] });
      const parallel = await s.primitives.add("line", { from: [15, 12], to: [0, 12] });
      const diagonal = await s.primitives.add("line", { from: [0, -15], to: [15, -5] });
      const point = await s.primitives.add("point", { position: [-8, 18] });
      await tool.reload(); tool.choose("select");
      const drag = s.drag.bind(s), update = s.dimensions.update.bind(s.dimensions), proxy = s.getProxy.bind(s);
      s.drag = async (...args) => {
        window.dimensionCheck.calls.push(args);
        const result = await drag(...args);
        if (window.dimensionCheck.holdNext) {
          window.dimensionCheck.holdNext = false;
          await new Promise(resolve => { window.dimensionCheck.release = resolve; });
        }
        return result;
      };
      window.dimensionCheck.annotations = []; window.dimensionCheck.proxyCalls = 0;
      s.dimensions.update = (...args) => { window.dimensionCheck.annotations.push(args); return update(...args); };
      s.getProxy = (...args) => { window.dimensionCheck.proxyCalls++; return proxy(...args); };
      return { circle, line, parallel, diagonal, point };
    });
    const inference = await page.evaluate(async refs => {
      const { inferDimension, dimensionChoices, dimensionLayout } = await import("/src/sketch-dimensions.ts"), state = window.dimensionCheck.tool.state;
      const infer = (refs, at, override) => inferDimension(state, new Set(refs.map(r => r.id)), at, override);
      const circle = infer(refs.circle.curves), line = infer(refs.line.curves), parallel = infer([...refs.line.curves, ...refs.parallel.curves]);
      const angle = infer([...refs.line.curves, ...refs.diagonal.curves], [25, 2]);
      const pointLine = infer([refs.point.points[0], refs.line.curves[0]]), reversed = infer([refs.line.curves[0], refs.point.points[0]]);
      const points = infer([refs.line.points[0], refs.parallel.points[0]]);
      const horizontal = infer([refs.parallel.curves[0]], undefined, "horizontalDistance");
      const alternatives = dimensionChoices(state, new Set(refs.circle.curves.map(r => r.id)));
      const branches = [[25, 2], [25, -3], [18, -2], [18, 2]].map(at => infer([...refs.line.curves, ...refs.diagonal.curves], at));
      return { circle, line, parallel, angle, pointLine, reversed, points, horizontal, alternatives, branches,
        layout: dimensionLayout(state, { kind: "length", parameters: { line: refs.line.curves[0], mode: "driving", annotation: { position: [7, 5] } } }) };
    }, refs);
    assert.equal(inference.circle.kind, "radius"); assert.equal(inference.line.kind, "length"); assert.equal(inference.parallel.kind, "distance");
    assert.equal(inference.angle.kind, "angle"); assert.equal(inference.pointLine.value, 18); assert.equal(inference.reversed.value, 18);
    assert.equal(inference.points.kind, "distance"); assert.equal(inference.horizontal.value, 15);
    assert.deepEqual(inference.alternatives, ["radius", "diameter"]);
    assert.ok(inference.branches.every(b => b.value > 0 && b.value < 180));
    assert.ok(new Set(inference.branches.map(b => Math.round(b.value))).size === 2, "Placement chooses either angular sector");
    assert.equal(inference.layout.segments.length, 3); assert.equal(inference.layout.arrows.length, 2);

    // Circle-rim mouse updates use the same one-in-flight/latest-target loop as points and lines.
    const p = await screen([-23, 0]), target = await screen([-26, 0]);
    await page.evaluate(() => { window.dimensionCheck.holdNext = true; });
    await page.mouse.move(...p); await page.mouse.down(); await page.mouse.move(p[0] - 2, p[1]);
    await page.waitForFunction(() => !!window.dimensionCheck.release);
    await page.mouse.move(...target, { steps: 8 }); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.dimensionCheck.calls.length), 1);
    await page.evaluate(() => window.dimensionCheck.release()); await idle();
    const dragged = await page.evaluate(refs => {
      const s = window.dimensionCheck.tool.state;
      return { center: s.entities.find(e => e.reference.id === refs.circle.points[0].id).geometry.position,
        radius: s.entities.find(e => e.reference.id === refs.circle.curves[0].id).geometry.radius, calls: window.dimensionCheck.calls };
    }, refs);
    near(dragged.center, [-18, 0]); assert.equal(dragged.calls.length, 2); assert.ok(dragged.calls.every(c => c[1].position));
    near([dragged.radius], [Math.hypot(dragged.calls[1][1].position[0] + 18, dragged.calls[1][1].position[1])]);

    // Select-first D workflow: measured preview, click placement, formula Enter.
    await page.mouse.click(...await screen([-18 - dragged.radius, 0])); await page.keyboard.press("d");
    assert.equal(await page.locator("#sketch-dimension-mode").count(), 0);
    await page.mouse.move(...await screen([-28, 13])); await page.mouse.click(...await screen([-28, 13]));
    const formula = page.getByRole("textbox", { name: "Dimension formula", exact: true });
    await idle();
    assert.equal(await page.locator(".sketch-popup").count(), 0, "Dimension creation uses a standalone input");
    assert.ok(await formula.evaluate(input => input.parentElement === document.querySelector("#model-canvas").parentElement));
    let bounds = await formula.boundingBox();
    near([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], await screen([-28, 13]), 1);
    await formula.fill("20 / 2"); await formula.press("Enter"); await idle();
    const original = await page.evaluate(() => {
      const t = window.dimensionCheck.tool, d = t.state.dimensions[0];
      return { id: d.id, position: d.parameters.annotation.position, entities: t.state.entities, revision: String(t.state.revision), status: t.state.status };
    });
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions[0].computed.value), 10);
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.tool), "dimension");
    await page.keyboard.press("Escape");

    // Annotation drag remains entirely local until release and never requests a proxy.
    await page.evaluate(() => { window.dimensionCheck.annotations = []; window.dimensionCheck.proxyCalls = 0; });
    const label = await screen(original.position), end = [label[0] + 40, label[1] - 24];
    await page.mouse.move(...label); await page.mouse.down(); await page.mouse.move(...end, { steps: 12 });
    assert.equal(await page.evaluate(() => window.dimensionCheck.annotations.length), 0);
    assert.equal(await page.evaluate(() => window.dimensionCheck.proxyCalls), 0);
    await page.mouse.up(); await idle();
    const after = await page.evaluate(() => {
      const t = window.dimensionCheck.tool;
      return { annotations: window.dimensionCheck.annotations, proxyCalls: window.dimensionCheck.proxyCalls, entities: t.state.entities, revision: String(t.state.revision), status: t.state.status, position: t.state.dimensions[0].parameters.annotation.position };
    });
    assert.equal(after.annotations.length, 1); assert.equal(after.proxyCalls, 0);
    assert.deepEqual(after.entities, original.entities); assert.equal(after.revision, original.revision); assert.deepEqual(after.status, original.status);
    assert.notDeepEqual(after.position, original.position);

    // Escape while dragging restores annotation position without a core update.
    const moved = await screen(after.position);
    await page.mouse.move(...moved); await page.mouse.down(); await page.mouse.move(moved[0] + 20, moved[1] + 12);
    await page.keyboard.press("Escape"); await page.mouse.up(); await idle();
    assert.equal(await page.evaluate(() => window.dimensionCheck.annotations.length), 1);
    assert.deepEqual(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions[0].parameters.annotation.position), after.position);
    await page.mouse.dblclick(...await screen(after.position));
    assert.equal(await formula.inputValue(), "20 / 2", "Editing preserves the formula expression");
    await formula.fill("12.345678901 mm"); await formula.press("Enter"); await idle();
    const precise = await page.evaluate(() => {
      const t = window.dimensionCheck.tool;
      return { dimension: t.state.dimensions[0], entities: t.state.entities, revision: String(t.state.revision), updates: window.dimensionCheck.annotations.length };
    });
    await page.mouse.dblclick(...await screen(after.position));
    assert.equal(await formula.inputValue(), "12.3457 mm");
    const fieldStyle = await formula.evaluate(input => ({ height: input.getBoundingClientRect().height, width: input.getBoundingClientRect().width, fontSize: getComputedStyle(input).fontSize, outline: getComputedStyle(input).outlineStyle, color: getComputedStyle(input).color }));
    assert.equal(fieldStyle.height, 20); assert.ok(fieldStyle.width < 120); assert.equal(fieldStyle.fontSize, "10px"); assert.equal(fieldStyle.outline, "none"); assert.equal(fieldStyle.color, "rgb(17, 17, 17)");
    assert.equal(await page.locator(".sketch-popup").count(), 0, "Dimension editing has no popup shell");
    await idle();
    bounds = await formula.boundingBox();
    near([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], await screen(after.position), 1);
    const view = await page.evaluate(() => window.dimensionCheck.viewport.captureView());
    await page.evaluate(view => window.dimensionCheck.viewport.restoreView({ ...view, zoom: view.zoom * 1.2,
      position: view.position.map((v, i) => v + (i === 0 ? -2 : 0)), target: view.target.map((v, i) => v + (i === 0 ? -2 : 0)) }), view);
    await idle();
    const transformed = await formula.boundingBox();
    assert.notEqual(transformed.x, bounds.x, "Dimension input follows view movement");
    near([transformed.x + transformed.width / 2, transformed.y + transformed.height / 2], await screen(after.position), 1);
    assert.equal(await formula.inputValue(), "12.3457 mm");
    await page.evaluate(view => window.dimensionCheck.viewport.restoreView(view), view); await idle();
    await page.screenshot({ path: "/private/tmp/pamatcad-dimension-edit.png" });
    await formula.press("Enter"); await idle();
    const unchanged = await page.evaluate(() => {
      const t = window.dimensionCheck.tool;
      return { dimension: t.state.dimensions[0], entities: t.state.entities, revision: String(t.state.revision), updates: window.dimensionCheck.annotations.length };
    });
    assert.deepEqual(unchanged, precise, "Accepting a rounded field must not update the formula or geometry");
    await page.mouse.dblclick(...await screen(after.position));
    await formula.fill("99 mm"); await formula.press("Escape"); await idle();
    assert.equal(await formula.count(), 0);
    assert.deepEqual(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions[0]), precise.dimension, "Escape discards inline formula edits");
    await page.mouse.dblclick(...await screen(after.position));
    await formula.fill("2 deg"); await formula.press("Enter"); await idle();
    assert.ok(await formula.isVisible(), "Invalid formulas remain editable");
    assert.ok(await page.locator("#sketch-error").textContent());
    assert.deepEqual(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions[0]), precise.dimension);
    await formula.press("Escape");
    await page.mouse.dblclick(...await screen(after.position));
    await formula.fill("12 mm"); await formula.press("Enter"); await idle();
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions[0].computed.value), 12);

    // Tool-first workflow accumulates selections; a length dimension uses a single line.
    await page.keyboard.press("Escape"); await page.keyboard.press("d");
    await page.mouse.click(...await screen([8, 0])); await page.mouse.click(...await screen([8, 5]));
    await formula.fill("30 / 2"); await formula.press("Enter"); await idle();
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.at(-1).kind), "length");
    await page.screenshot({ path: "/private/tmp/pamatcad-dimensions.png" });

    await page.keyboard.press("Escape");

    // Context menu owns mode/name, while double-click only edits the formula.
    const lengthPosition = await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.at(-1).parameters.annotation.position);
    await page.mouse.click(...await screen(lengthPosition), { button: "right" });
    await page.getByRole("textbox", { name: "Dimension name" }).fill("width");
    await page.getByRole("button", { name: "Rename", exact: true }).click(); await idle();
    await page.mouse.dblclick(...await screen(lengthPosition)); await idle();
    assert.equal(await page.evaluate(() => {
      const { tool, viewport } = window.dimensionCheck, id = tool.state.dimensions.at(-1).id;
      return viewport.sketchDisplay.children.find(n => n.isSprite && n.userData.pick?.id === id).visible;
    }), false, "The inline field replaces the named dimension label");
    await page.screenshot({ path: "/private/tmp/pamatcad-dimension-named-edit.png" });
    await formula.press("Escape"); await idle();
    assert.equal(await page.evaluate(() => {
      const { tool, viewport } = window.dimensionCheck, id = tool.state.dimensions.at(-1).id;
      return viewport.sketchDisplay.children.find(n => n.isSprite && n.userData.pick?.id === id).visible;
    }), true, "Closing the inline field restores the label");
    await page.mouse.click(...await screen(lengthPosition), { button: "right" });
    await page.getByRole("button", { name: "Make driven", exact: true }).click(); await idle();
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.at(-1).parameters.mode), "driven");
    await page.mouse.click(...await screen(lengthPosition)); await page.keyboard.press("Delete"); await idle();
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.length), 1);
    // Actual two-reference picking: parallel lines, nonparallel lines, point/line.
    await page.keyboard.press("Escape"); await page.keyboard.press("d");
    await page.mouse.click(...await screen([8, 0])); await page.mouse.click(...await screen([8, 12]));
    await page.mouse.click(...await screen([18, 7])); await formula.press("Enter"); await idle();
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.at(-1).kind), "distance");
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.at(-1).parameters.curves.length), 2);
    await page.keyboard.press("Escape"); await page.keyboard.press("d");
    await page.mouse.click(...await screen([8, 0])); await page.mouse.click(...await screen([6, -11]));
    await page.mouse.click(...await screen([16, -2])); await formula.press("Enter"); await idle();
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.at(-1).kind), "angle");
    await page.keyboard.press("Escape"); await page.keyboard.press("d");
    await page.mouse.click(...await screen([-8, 18])); await page.mouse.click(...await screen([8, 12]));
    await page.mouse.click(...await screen([-3, 16])); await formula.press("Enter"); await idle();
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.at(-1).parameters.points.length), 1);
    assert.ok(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.at(-1).parameters.line));
    await page.screenshot({ path: "/private/tmp/pamatcad-dimensions-all.png" });

    // A dimension draft and inline input never commit during document suspension.
    const current = await page.locator('#document-tabs [aria-selected="true"]').getAttribute("data-document");
    const count = await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.length);
    await page.keyboard.press("Escape"); await page.keyboard.press("d");
    await page.mouse.click(...await screen([8, 0])); await page.mouse.click(...await screen([6, -6]));
    assert.ok(await formula.isVisible());
    await formula.fill("99 mm"); await formula.press("Escape"); await idle();
    assert.equal(await formula.count(), 0);
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.length), count, "Escape discards dimension creation");
    await page.keyboard.press("d");
    await page.mouse.click(...await screen([6, -6]));
    assert.ok(await formula.isVisible());
    await page.getByText("File", { exact: true }).click(); await page.locator("#menu-new").click();
    await page.waitForFunction(id => document.querySelector('#document-tabs [aria-selected="true"]')?.getAttribute("data-document") !== id, current);
    await page.locator(`#document-tabs [data-document="${current}"]`).click();
    assert.equal(await formula.count(), 0);
    assert.equal(await page.evaluate(() => window.dimensionCheck.tool.state.dimensions.length), count);
    await page.keyboard.press("Escape");
    await page.locator("#apply").click();
    await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
    const persisted = await page.evaluate(async () => {
      const s = window.dimensionCheck.tool.sketch; await s.edit(); const state = await s.state(); await s.cancel(); return state.dimensions[0].parameters.annotation.position;
    });
    assert.deepEqual(persisted, after.position);
    console.log("Sketch dimensions: inference, circle rim coalescing, canvas placement/formula, local annotation drag/cancel, context mode/name, delete and persistence passed");
  } finally { await page.evaluate(() => { delete window.dimensionCheck; }); }
}
