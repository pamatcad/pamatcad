import assert from "node:assert/strict";

export async function testNavigation(page) {
  await page.addScriptTag({ path: "tests/editor/rectangle.js" });
  await page.getByText("File", { exact: true }).click();
  await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled && !document.querySelector("#features").children.length);
  // Inspect the actual editor instance without adding a production test API.
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts");
    const start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) {
      window.navigationCheck = { tool: this, viewport: this.viewport };
      return start.apply(this, args);
    };
    try {
      document.querySelector("#new-sketch").click();
      while (!window.navigationCheck) await new Promise(resolve => setTimeout(resolve, 10));
    } finally { SketchTool.prototype.start = start; }
  });
  try {
    await page.evaluate(() => chooseSketchPlane("XY"));
    await page.waitForFunction(() => !document.querySelector("#apply").disabled);
    await page.evaluate(async () => {
      const { tool } = window.navigationCheck;
      await tool.sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
      const point = await tool.sketch.primitives.add("point", { position: [-10, 5] });
      window.navigationCheck.point = point.points[0];
      await tool.reload();
      tool.choose("select");
    });

    const read = () => page.evaluate(async () => {
      const { tool, viewport } = window.navigationCheck;
      return {
        view: viewport.captureView(), state: await tool.sketch.state(),
        timeline: await tool.scene.timeline.list(), selected: [...tool.selected],
        fields: [...document.querySelectorAll("#tool-panel input, #tool-panel select, .sketch-live-dimensions input")].map(f => [f.id, f.value, f.checked]),
      };
    });
    const delta = (a, b) => a.map((n, i) => n - b[i]);
    const near = (a, b) => assert.ok(Math.hypot(...delta(a, b)) < 1e-8, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    const unchanged = (before, after) => {
      for (const key of ["state", "timeline", "selected", "fields"]) assert.deepEqual(after[key], before[key], key + " must survive navigation");
    };
    const cameraUnchanged = (a, b) => {
      assert.equal(a.mode, b.mode); near(a.position, b.position); near(a.target, b.target); near(a.up, b.up);
      near([a.zoom, a.span], [b.zoom, b.span]);
    };
    const drag = async (button, shift = false, origin) => {
      const canvas = await page.locator("#model-canvas").boundingBox();
      const [x, y] = origin ?? [canvas.x + canvas.width * 0.25, canvas.y + canvas.height * 0.7];
      await page.mouse.move(x, y);
      if (shift) await page.keyboard.down("Shift");
      await page.mouse.down({ button });
      await page.mouse.move(x + 65, y - 35, { steps: 6 });
      await page.mouse.up({ button });
      if (shift) await page.keyboard.up("Shift");
    };
    const reset = mode => page.evaluate(mode => window.navigationCheck.viewport.restoreView({
      mode, position: [30, -40, 50], target: [0, 0, 0], up: [0, 0, 1], span: 60, zoom: 1,
    }), mode);
    const screenPoint = xy => page.evaluate(xy => {
      const { tool, viewport } = window.navigationCheck, frame = tool.state.frame;
      viewport.camera.updateMatrixWorld();
      const p = viewport.camera.position.clone().fromArray(frame.origin)
        .addScaledVector(viewport.camera.position.clone().fromArray(frame.u), xy[0])
        .addScaledVector(viewport.camera.position.clone().fromArray(frame.v), xy[1]).project(viewport.camera);
      const r = document.querySelector("#model-canvas").getBoundingClientRect();
      return [r.x + (p.x + 1) * r.width / 2, r.y + (1 - p.y) * r.height / 2];
    }, xy);

    for (const mode of ["orthographic", "perspective"]) {
      await reset(mode);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const box = await page.locator("#model-canvas").boundingBox();
      const cube = [box.x + box.width - 60, box.y + 60];
      // Put an editable point behind the overlay to catch event-routing regressions.
      await page.evaluate(async ([x, y]) => {
        const { tool, viewport } = window.navigationCheck;
        const r = document.querySelector("#model-canvas").getBoundingClientRect(), ray = new viewport.ray.constructor();
        ray.setFromCamera({x:(x-r.x)/r.width*2-1,y:1-(y-r.y)/r.height*2},viewport.camera);
        const p = ray.ray.at(-ray.ray.origin.z/ray.ray.direction.z,viewport.camera.position.clone());
        await tool.sketch.primitives.add("point", { position: [p.x,p.y] }); await tool.reload();
      },cube);
      let before = await read();
      await page.mouse.move(...cube); await page.mouse.down();
      await page.mouse.move(cube[0]-95,cube[1]+75,{steps:8}); await page.mouse.up();
      let after = await read(); unchanged(before,after);
      assert.ok(Math.hypot(...delta(after.view.position,before.view.position))>0.1,mode+" cube drag orbits");
      near(after.view.target,before.view.target); near([after.view.zoom,after.view.span],[before.view.zoom,before.view.span]);
      near([Math.hypot(...delta(after.view.position,after.view.target))],[Math.hypot(...delta(before.view.position,before.view.target))]);
      assert.equal(await page.evaluate(()=>!!window.navigationCheck.viewport.gizmoDrag),false,"Release outside cube clears gesture");
      await page.mouse.click(...cube); after=await read(); unchanged(before,after);
      const d=delta(after.view.position,after.view.target), magnitude=Math.hypot(...d);
      assert.ok(Math.max(...d.map(Math.abs))/magnitude>0.9999,"Cube face click still aligns view");
      before=after;
      await page.mouse.move(...cube); await page.mouse.down();
      await page.evaluate(()=>{const v=window.navigationCheck.viewport;document.querySelector("#model-canvas").dispatchEvent(new PointerEvent("pointercancel",{pointerId:v.gizmoDrag.pointer,bubbles:true}));});
      await page.mouse.up(); after=await read(); unchanged(before,after); cameraUnchanged(before.view,after.view);
      assert.equal(await page.evaluate(()=>!!window.navigationCheck.viewport.gizmoDrag),false);
    }

    for (const mode of ["orthographic", "perspective"]) {
      await reset(mode);
      let before = await read();
      await drag("middle");
      let after = await read(); unchanged(before, after);
      assert.ok(Math.hypot(...delta(after.view.target, before.view.target)) > 0.1, mode + " pan moves the target");
      near(delta(after.view.position, after.view.target), delta(before.view.position, before.view.target));
      near([after.view.zoom], [before.view.zoom]);

      before = after; await drag("middle", true); after = await read(); unchanged(before, after);
      near(after.view.target, before.view.target);
      near([Math.hypot(...delta(after.view.position, after.view.target))], [Math.hypot(...delta(before.view.position, before.view.target))]);
      assert.ok(Math.hypot(...delta(after.view.position, before.view.position)) > 0.1, mode + " orbit changes orientation");

      before = after; await drag("left"); after = await read(); cameraUnchanged(before.view, after.view);
      before = after; await drag("right"); after = await read(); unchanged(before, after); cameraUnchanged(before.view, after.view);
      before = after; await page.mouse.wheel(0, -120);
      after = await read(); unchanged(before, after);
      assert.ok(after.view.zoom !== before.view.zoom || Math.hypot(...delta(after.view.position, before.view.position)) > 0.1, mode + " wheel zooms");
    }

    await page.evaluate(() => window.navigationCheck.viewport.restoreView({ mode: "orthographic", position: [0, 0, 60], target: [0, 0, 0], up: [0, 1, 0], span: 60, zoom: 1 }));
    let point = await screenPoint([-10, 5]);
    await page.mouse.click(...point);
    await page.keyboard.down("Shift"); await page.mouse.click(...await screenPoint([0, 0])); await page.keyboard.up("Shift");
    assert.equal((await read()).selected.length, 2, "Shift-left adds to selection without orbiting");
    let before = await read();
    await drag("left", false, point);
    await page.waitForFunction(() => !window.navigationCheck.tool.pending);
    let after = await read(); cameraUnchanged(before.view, after.view);
    const pointId = await page.evaluate(() => window.navigationCheck.point.id);
    assert.notDeepEqual(after.state.entities.find(e => e.reference.id === pointId).geometry, before.state.entities.find(e => e.reference.id === pointId).geometry);
    point = await screenPoint(after.state.entities.find(e => e.reference.id === pointId).geometry.position);
    before = after; await drag("middle", false, point); after = await read(); unchanged(before, after);

    // Navigate while waiting for the second rectangle corner.
    await page.locator('#sketch-ribbon [data-tool="rectangle"]').click();
    await page.mouse.click(...await screenPoint([-15, -8]));
    // Keep the pointer clear of the live dimension inputs beside the first corner.
    const draftCorner = await screenPoint([-5, -3]);
    assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, draftCorner), "model-canvas");
    await page.mouse.move(...draftCorner);
    await page.waitForFunction(() => window.navigationCheck.tool.draftValid && !window.navigationCheck.tool.pending);
    before = await read();
    const cubeBounds=await page.locator("#model-canvas").boundingBox();
    await drag("left",false,[cubeBounds.x+cubeBounds.width-60,cubeBounds.y+60]);
    after=await read();unchanged(before,after);
    assert.ok(Math.hypot(...delta(after.view.position,before.view.position))>0.1,"Cube drag preserves unfinished geometry");
    await page.mouse.move(...draftCorner); before=await read();
    await page.mouse.down({ button: "middle" }); await page.mouse.move(point[0] + 40, point[1] + 40, { steps: 6 }); await page.mouse.up({ button: "middle" });
    after = await read(); unchanged(before, after);
    before = after;
    await page.keyboard.down("Shift"); await page.mouse.down({ button: "middle" }); await page.mouse.move(point[0] + 80, point[1], { steps: 6 }); await page.mouse.up({ button: "middle" }); await page.keyboard.up("Shift");
    after = await read(); unchanged(before, after);

    // A late preview must not restore a draft after Escape.
    await page.evaluate(() => {
      const check = window.navigationCheck, primitives = check.tool.sketch.primitives;
      const add = primitives.add;
      check.restoreAdd = () => { primitives.add = add; };
      primitives.add = async (...args) => {
        const result = await add(...args);
        if (args[2]?.preview) await new Promise(resolve => { check.releasePreview = resolve; });
        return result;
      };
      const field = document.querySelector("#width");
      field.value = "8";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => !!window.navigationCheck.releasePreview);
    await page.keyboard.press("Escape");
    assert.ok(await page.locator("#sketch-workspace").isVisible());
    assert.equal(await page.locator('#sketch-ribbon [aria-pressed="true"]').count(), 0);
    await page.evaluate(() => { window.navigationCheck.restoreAdd(); window.navigationCheck.releasePreview(); });
    await page.waitForFunction(() => !window.navigationCheck.tool.pending);
    after = await read();
    assert.deepEqual(after.state, before.state, "Canceled previews never change working geometry");
    const display = await page.evaluate(() => {
      const { tool, viewport } = window.navigationCheck;
      return { working: tool.proxy.curves.map(c => c.entity.id), visible: viewport.sketchDisplayState[1].curves.map(c => c.entity.id), cached: viewport.sketches.children.length };
    });
    assert.deepEqual(display.visible, display.working, "Late preview completion does not replace the working display");
    assert.equal(await page.locator(".sketch-live-dimensions").isVisible(), false);
    await page.locator("#apply").click();
    await page.waitForFunction(() => !document.querySelector("#extrude").disabled);
    await page.locator("#extrude").click();
    await page.waitForFunction(() => !document.querySelector("#apply").disabled);
    before = await read();
    const previewCube = await page.locator("#model-canvas").boundingBox();
    const previewBodies = await page.evaluate(() => window.navigationCheck.viewport.preview.children.map(body => body.proxy));
    assert.ok(previewBodies.length > 0);
    await drag("left", false, [previewCube.x + previewCube.width - 60, previewCube.y + 60]);
    after = await read(); unchanged(before, after);
    assert.ok(Math.hypot(...delta(after.view.position, before.view.position)) > 0.1, "Cube drag orbits an extrusion preview");
    assert.deepEqual(await page.evaluate(() => window.navigationCheck.viewport.preview.children.map(body => body.proxy)), previewBodies);
    before = await read(); await drag("middle"); after = await read(); unchanged(before, after);
    before = after; await drag("middle", true); after = await read(); unchanged(before, after);
    const handle = page.locator('[data-handle="length"]');
    let h = await handle.boundingBox();
    before = await read(); await drag("middle", false, [h.x + h.width / 2, h.y + h.height / 2]); after = await read(); unchanged(before, after);
    h = await handle.boundingBox();
    before = after; await drag("right", false, [h.x + h.width / 2, h.y + h.height / 2]); after = await read(); unchanged(before, after);
    h = await handle.boundingBox();
    before = after; const length = await page.locator("#length").inputValue();
    await drag("left", false, [h.x + h.width / 2, h.y + h.height / 2]);
    await page.waitForFunction(() => !document.querySelector("#apply").disabled);
    after = await read(); cameraUnchanged(before.view, after.view);
    assert.notEqual(await page.locator("#length").inputValue(), length, "Left-drag edits the extrusion handle");
    await page.locator("#cancel").click();
    console.log("Navigation: cube drag/click/cancel, middle pan, Shift-middle orbit, wheel zoom, point/handle editing and draft preservation passed in both projections");
  } finally { await page.evaluate(() => { delete window.navigationCheck; }); }
}
