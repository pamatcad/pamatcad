import assert from "node:assert/strict";

export async function testSketchDragging(page) {
  await page.addScriptTag({ path: "tests/editor/rectangle.js" });
  await page.getByText("File", { exact: true }).click();
  await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled && !document.querySelector("#features").children.length);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts");
    const start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) {
      window.dragCheck = { tool: this, viewport: this.viewport, calls: [] };
      return start.apply(this, args);
    };
    try {
      document.querySelector("#new-sketch").click();
      while (!window.dragCheck) await new Promise(resolve => setTimeout(resolve, 10));
    } finally { SketchTool.prototype.start = start; }
  });
  const near = (actual, expected) => assert.ok(Math.hypot(...actual.map((n, i) => n - expected[i])) < 1e-6, `${actual} != ${expected}`);
  const screen = xy => page.evaluate(xy => {
    const { tool, viewport } = window.dragCheck, frame = tool.state.frame;
    viewport.camera.updateMatrixWorld();
    const p = viewport.camera.position.clone().fromArray(frame.origin)
      .addScaledVector(viewport.camera.position.clone().fromArray(frame.u), xy[0])
      .addScaledVector(viewport.camera.position.clone().fromArray(frame.v), xy[1]).project(viewport.camera);
    const r = document.querySelector("#model-canvas").getBoundingClientRect();
    return [r.x + (p.x + 1) * r.width / 2, r.y + (1 - p.y) * r.height / 2];
  }, xy);
  const point = id => page.evaluate(id => window.dragCheck.tool.state.entities.find(e => e.reference.id === id).geometry.position, id);
  const idle = () => page.waitForFunction(() => !window.dragCheck.tool.pending && !window.dragCheck.tool.updateRunning && !window.dragCheck.tool.dragQueued);
  try {
    await page.evaluate(() => chooseSketchPlane("XY"));
    await page.waitForFunction(() => !document.querySelector("#apply").disabled);
    const setup = await page.evaluate(async () => {
      const check = window.dragCheck, tool = check.tool;
      await tool.sketch.primitives.add("rectangle", { from: [-15, 15], to: [15, -15] });
      await tool.reload(); tool.choose("select");
      const at = (x, y) => tool.state.entities.find(e => e.geometry.type === "point" && e.geometry.position[0] === x && e.geometry.position[1] === y).reference.id;
      const original = tool.sketch.drag.bind(tool.sketch);
      check.controls = [];
      check.tabs = [...document.querySelectorAll('#document-tabs [role="tab"]')];
      check.changed = tool.hooks.changed;
      tool.hooks.changed = (...args) => {
        check.changed(...args);
        if (tool.dragEntity || tool.dragQueued || tool.updateRunning) check.controls.push({
          finish: document.querySelector("#apply").disabled,
          ribbon: [...document.querySelectorAll('#sketch-ribbon [data-tool]')].some(b => b.disabled),
          tabs: [...document.querySelectorAll('#document-tabs [role="tab"]')].every((tab, i) =>
            tab === check.tabs[i] && getComputedStyle(tab).opacity === "1" && tab.textContent === tab.title),
        });
      };
      tool.sketch.drag = async (...args) => {
        check.calls.push(args);
        const result = await original(...args);
        if (check.holdNext) {
          check.holdNext = false;
          await new Promise(resolve => { check.release = resolve; });
        }
        return result;
      };
      return { topLeft: at(-15, 15), bottomRight: at(15, -15), view: tool.viewport.captureView(), revision: tool.state.revision };
    });
    let p = await screen([-15, 15]);
    // Pick the exposed side of the vertex, clear of its coincidence label.
    p[0] += 3;
    await page.mouse.click(...p);
    assert.equal(await page.evaluate(() => window.dragCheck.calls.length), 0, "A selection click does not drag");
    assert.equal(await page.evaluate(() => window.dragCheck.tool.state.revision), setup.revision);
    assert.ok(await page.evaluate(() => window.dragCheck.tool.selected.size === 1 && [...window.dragCheck.tool.selected].every(id => window.dragCheck.tool.state.entities.some(e => e.reference.id === id && e.geometry.type === "point"))));

    // Two pixels is inside the old eight-pixel self-snap dead zone.
    await page.mouse.move(...p); await page.mouse.down();
    await page.mouse.move(p[0] + 2, p[1] - 2); await idle();
    assert.equal(await page.locator("#apply").isDisabled(), true, "Finish stays disabled while the mouse is held, even with no request in flight");
    await page.mouse.up(); await idle();
    assert.equal(await page.locator("#apply").isDisabled(), false);
    const smallTarget = await page.evaluate(([x, y]) => window.dragCheck.viewport.point({ clientX: x, clientY: y }), [p[0] + 2, p[1] - 2]);
    near(await point(setup.topLeft), smallTarget);
    assert.ok(Math.hypot(smallTarget[0] + 15, smallTarget[1] - 15) > 0.01);
    near(await point(setup.bottomRight), [15, -15]);

    // Keep the first response pending through several pointer events and release.
    await page.evaluate(() => { window.dragCheck.calls = []; window.dragCheck.holdNext = true; });
    const opposite = await point(setup.topLeft);
    p = await screen([15, -15]);
    p[0] += 3;
    await page.mouse.move(...p); await page.mouse.down();
    await page.mouse.move(p[0] + 2, p[1] + 2);
    await page.waitForFunction(() => !!window.dragCheck.release);
    await page.mouse.move(p[0] + 48, p[1] + 32, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.locator("#apply").isDisabled(), true, "The released target must settle before Finish is enabled");
    assert.equal(await page.evaluate(() => window.dragCheck.calls.length), 1, "Only one drag may be in flight");
    const target = await page.evaluate(([x, y]) => window.dragCheck.viewport.point({ clientX: x, clientY: y }), [p[0] + 48, p[1] + 32]);
    await page.evaluate(() => window.dragCheck.release()); await idle();
    assert.equal(await page.evaluate(() => window.dragCheck.calls.length), 2, "Intermediate pointer positions are coalesced");
    assert.equal(await page.locator("#apply").isDisabled(), false);
    const controls = await page.evaluate(() => window.dragCheck.controls);
    assert.ok(controls.length > 4 && controls.every(c => c.finish && !c.ribbon), "Drag response boundaries never flash the ribbon or Finish button");
    assert.ok(controls.every(c => c.tabs), "Dragging retains tab elements and full-opacity titles");
    near(await point(setup.bottomRight), target);
    near(await point(setup.topLeft), opposite);
    assert.deepEqual(await page.evaluate(() => window.dragCheck.viewport.captureView()), setup.view);
    assert.equal(await page.evaluate(() => window.dragCheck.tool.state.status.degreesOfFreedom), 4);
    await page.screenshot({ path: "/private/tmp/pamatcad-drag-fixed.png" });

    await page.evaluate(async () => {
      const tool = window.dragCheck.tool;
      await tool.sketch.primitives.add("point", { position: [-25, 20] });
      await tool.reload();
    });
    p = await screen(await point(setup.topLeft));
    p[0] += 3;
    const other = await screen([-25, 20]);
    await page.mouse.move(...p); await page.mouse.down();
    await page.mouse.move(other[0] + 3, other[1] + 2); await page.mouse.up(); await idle();
    near(await point(setup.topLeft), [-25, 20]);
    near(await point(setup.bottomRight), target);
    assert.deepEqual(await page.evaluate(() => window.dragCheck.viewport.captureView()), setup.view);

    // Returning to the pointer-down position updates the geometry before release too.
    p = await screen(target); p[0] += 3;
    await page.mouse.move(...p); await page.mouse.down();
    await page.mouse.move(p[0] + 12, p[1] + 8); await idle();
    await page.mouse.move(...p); await idle();
    const returned = await page.evaluate(([x, y]) => window.dragCheck.viewport.point({ clientX: x, clientY: y }), p);
    near(await point(setup.bottomRight), returned);
    near(await point(setup.topLeft), [-25, 20]);
    await page.mouse.up(); await idle();

    const edge = (axis, coordinate) => page.evaluate(({ axis, coordinate }) => {
      const state = window.dragCheck.tool.state;
      const position = id => state.entities.find(e => e.reference.id === id).geometry.position;
      const line = state.entities.find(e => e.geometry.type === "line" &&
        [e.geometry.from, e.geometry.to].every(id => Math.abs(position(id)[axis] - coordinate) < 1e-6));
      return { id: line.reference.id, fromId: line.geometry.from, toId: line.geometry.to,
        from: position(line.geometry.from), to: position(line.geometry.to), revision: state.revision };
    }, { axis, coordinate });

    // A horizontal edge drag translates both endpoints from the start of the gesture.
    const top = await edge(1, 20), bottom = await edge(1, returned[1]);
    // Integer event coordinates keep the expected pointer delta independent of browser rounding.
    p = (await screen([(top.from[0] + top.to[0]) / 2, 20])).map(Math.round);
    await page.evaluate(() => { window.dragCheck.calls = []; });
    await page.mouse.click(...p);
    assert.equal(await page.evaluate(() => window.dragCheck.calls.length), 0);
    assert.equal(await page.evaluate(() => window.dragCheck.tool.state.revision), top.revision);
    assert.deepEqual(await page.evaluate(() => [...window.dragCheck.tool.selected]), [top.id]);
    await page.evaluate(() => { window.dragCheck.holdNext = true; delete window.dragCheck.release; });
    await page.mouse.move(...p); await page.mouse.down();
    await page.mouse.move(p[0], p[1] - 8);
    await page.waitForFunction(() => !!window.dragCheck.release);
    await page.mouse.move(p[0], p[1] - 32, { steps: 8 }); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.dragCheck.calls.length), 1);
    const up = await page.evaluate(([x, y]) => {
      const v = window.dragCheck.viewport, a = v.point({ clientX: x, clientY: y }), b = v.point({ clientX: x, clientY: y - 32 });
      return b[1] - a[1];
    }, p);
    await page.evaluate(() => window.dragCheck.release()); await idle();
    const edgeCalls = await page.evaluate(() => window.dragCheck.calls);
    assert.equal(edgeCalls.length, 2, "Edge dragging also keeps only the newest queued input");
    assert.ok(edgeCalls.every(([ref, target]) => ref.id === top.id && target.from && target.to));
    near(await point(top.fromId), edgeCalls[1][1].from);
    near(await point(top.toId), edgeCalls[1][1].to);
    near(await point(top.fromId), [top.from[0], top.from[1] + up]);
    near(await point(top.toId), [top.to[0], top.to[1] + up]);
    near(await point(bottom.fromId), bottom.from); near(await point(bottom.toId), bottom.to);

    // A vertical edge drag preserves the opposite edge and the camera.
    const right = await edge(0, returned[0]), left = await edge(0, -25);
    p = (await screen([returned[0], (right.from[1] + right.to[1]) / 2])).map(Math.round);
    await page.mouse.move(...p); await page.mouse.down();
    await page.mouse.move(p[0] + 16, p[1], { steps: 5 }); await page.mouse.up(); await idle();
    const across = await page.evaluate(([x, y]) => {
      const v = window.dragCheck.viewport, a = v.point({ clientX: x, clientY: y }), b = v.point({ clientX: x + 16, clientY: y });
      return b[0] - a[0];
    }, p);
    near(await point(right.fromId), [right.from[0] + across, right.from[1]]);
    near(await point(right.toId), [right.to[0] + across, right.to[1]]);
    near(await point(left.fromId), left.from); near(await point(left.toId), left.to);
    assert.equal(await page.evaluate(() => window.dragCheck.tool.state.status.degreesOfFreedom), 6);
    assert.deepEqual(await page.evaluate(() => window.dragCheck.viewport.captureView()), setup.view);
    await page.screenshot({ path: "/private/tmp/pamatcad-edge-drag.png" });

    // Two verticals plus a parallel-line distance contain valid redundant relations.
    const spaced = await page.evaluate(async () => {
      const { tool } = window.dragCheck, s = tool.sketch;
      const construction = await s.primitives.add("line", { from: [0, -10], to: [0, 10], construction: true });
      await s.constraints.add("vertical", { curves: construction.curves });
      await s.constraints.add("pointOnCurve", { points: [s.origin], curves: construction.curves });
      const line = await s.primitives.add("line", { from: [12.09, -15], to: [12.09, 8] });
      await s.constraints.add("vertical", { curves: line.curves });
      await s.dimensions.add("distance", { curves: [construction.curves[0], line.curves[0]], value: 12.09, mode: "driving", annotation: { position: [20, -20] } });
      await tool.reload(); tool.selected.clear(); tool.choose("select");
      window.dragCheck.calls = [];
      return { upper: line.points[1].id, before: tool.state, view: tool.viewport.captureView() };
    });
    p = (await screen([12.09, 8])).map(Math.round);
    const offAxis = [p[0] + 16, p[1] - 36];
    const attainable = await page.evaluate(([x, y]) => window.dragCheck.viewport.point({ clientX: x, clientY: y }), offAxis);
    assert.ok(Math.abs(attainable[0] - 12.09) > 0.1, "The mouse target includes a sideways component");
    await page.mouse.move(...p); await page.mouse.down();
    await page.mouse.move(...offAxis, { steps: 5 }); await page.mouse.up(); await idle();
    near(await point(spaced.upper), [12.09, attainable[1]]);
    const solved = await page.evaluate(() => window.dragCheck.tool.state);
    assert.deepEqual(solved.constraints, spaced.before.constraints);
    assert.deepEqual(solved.dimensions, spaced.before.dimensions);
    assert.deepEqual(solved.status, spaced.before.status);
    for (const entity of spaced.before.entities.filter(e => e.reference.id !== spaced.upper)) {
      const actual = solved.entities.find(e => e.reference.id === entity.reference.id);
      assert.deepEqual({ ...actual, geometry: entity.geometry }, entity);
      if (entity.geometry.type === "point") near(actual.geometry.position, entity.geometry.position);
      else assert.deepEqual(actual.geometry, entity.geometry);
    }
    assert.deepEqual(await page.evaluate(() => window.dragCheck.viewport.captureView()), spaced.view);
    assert.ok(await page.evaluate(id => window.dragCheck.calls.length > 0 && window.dragCheck.calls.every(([ref]) => ref.id === id), spaced.upper));
    await page.screenshot({ path: "/private/tmp/pamatcad-spaced-line-drag.png" });
    const arc = await page.evaluate(async () => {
      const c=window.dragCheck,t=c.tool;
      const arc=await t.sketch.primitives.add("arc",{center:[-12,-5],radius:3,start:0,end:180});
      await t.reload();t.selected.clear();t.choose("select");c.calls=[];c.holdNext=true;delete c.release;
      return arc;
    });
    p=await screen([-12,-2]);
    await page.mouse.move(...p);await page.mouse.down();await page.mouse.move(p[0],p[1]-5);
    await page.waitForFunction(()=>!!window.dragCheck.release);
    await page.mouse.move(...await screen([-12,1]),{steps:8});await page.mouse.up();
    assert.equal(await page.evaluate(()=>window.dragCheck.calls.length),1);
    await page.evaluate(()=>window.dragCheck.release());await idle();
    const resized=await page.evaluate(arc=>{const c=window.dragCheck,s=c.tool.state;return {geometry:s.entities.find(e=>e.reference.id===arc.curves[0].id).geometry,calls:c.calls};},arc);
    assert.equal(resized.calls.length,2);assert.ok(resized.calls.every(([ref,target])=>ref.id===arc.curves[0].id&&target.position));
    near([resized.geometry.radius],[Math.hypot(resized.calls[1][1].position[0]+12,resized.calls[1][1].position[1]+5)]);
    near(await point(arc.points[0].id),[-12,-5]);near([resized.geometry.start,resized.geometry.end],[0,Math.PI]);
    p=await screen([-12,-5]);await page.mouse.move(...p);await page.mouse.down();
    await page.mouse.move(...await screen([-15,-10]),{steps:6});await page.mouse.up();await idle();
    const translated=await page.evaluate(arc=>window.dragCheck.tool.state.entities.find(e=>e.reference.id===arc.curves[0].id).geometry,arc);
    near(await point(arc.points[0].id),[-15,-10]);
    near([translated.radius,translated.start,translated.end],[resized.geometry.radius,0,Math.PI]);
    assert.deepEqual(await page.evaluate(()=>window.dragCheck.viewport.captureView()),spaced.view);
    await page.screenshot({path:"/private/tmp/pamatcad-arc-drag.png"});
    await page.locator("#apply").click();
    await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled && document.querySelector("#features").children.length === 1);
    console.log("Sketch dragging: points, edges, arc rim/center, constrained endpoint projection, stable unrelated geometry, snapping, latest/release targets and camera preservation passed");
  } finally { await page.evaluate(() => {
    if (window.dragCheck.changed) window.dragCheck.tool.hooks.changed = window.dragCheck.changed;
    delete window.dragCheck;
  }); }
}
