import assert from "node:assert/strict";

export async function testSketchSplines(page) {
  await page.setViewportSize({width:1440,height:1000});
  await page.addScriptTag({path:"tests/editor/rectangle.js"});
  await page.getByText("File", {exact:true}).click(); await page.locator("#menu-new").click();
  await page.waitForFunction(()=>!document.querySelector("#new-sketch").disabled);
  await page.evaluate(async()=>{
    const {SketchTool}=await import("/src/tools/sketch.ts"), start=SketchTool.prototype.start;
    SketchTool.prototype.start=function(...args){window.splineCheck=this;return start.apply(this,args);};
    try {document.querySelector("#new-sketch").click();} finally {SketchTool.prototype.start=start;}
  });
  await page.evaluate(()=>chooseSketchPlane("XY"));
  const idle=()=>page.waitForFunction(()=>{const t=window.splineCheck;return t.state&&!t.pending&&!t.creating&&!t.updateRunning&&!t.previewQueued&&!t.viewport.renderPending;});
  const state=()=>page.evaluate(()=>window.splineCheck.state);
  const screen=xy=>page.evaluate(xy=>{
    const t=window.splineCheck,v=t.viewport,f=t.state.frame,r=document.querySelector("#model-canvas").getBoundingClientRect();v.camera.updateMatrixWorld();
    const p=v.camera.position.clone().fromArray(f.origin).addScaledVector(v.camera.position.clone().fromArray(f.u),xy[0]).addScaledVector(v.camera.position.clone().fromArray(f.v),xy[1]).project(v.camera);
    return [r.x+(p.x+1)*r.width/2,r.y+(1-p.y)*r.height/2];
  },xy);
  const click=async xy=>{await page.mouse.click(...await screen(xy));await idle();};
  const choose=async(mode="Fit points")=>{await page.keyboard.press("Escape");await idle();await page.locator('[data-tool="spline"]').click();await page.getByRole("button",{name:mode,exact:true}).click();await idle();};
  const finish=async()=>{await page.locator("#model-canvas").press("Enter");await idle();};
  try {
    await idle(); await choose(); assert.equal(await page.getByLabel("Closed",{exact:true}).count(),0);
    await click([-28,-12]);await click([-18,0]);await click([-8,-12]);await finish();
    let s=await state();assert.equal(s.splines.length,1);const first=s.splines[0],node=first.fitPoints[1];
    assert.equal(first.envelope.length,4);assert.equal(node.mode,"aligned");
    assert.ok(first.fitPoints.flatMap(p=>[p.incoming,p.outgoing].filter(Boolean)).every(r=>s.entities.find(e=>e.reference.id===r.id).construction));
    await page.keyboard.press("Escape");await idle();
    const before=s.entities;
    await page.mouse.dblclick(...await screen([-18,0]));await idle();
    s=await state();assert.equal(s.splines[0].fitPoints[1].mode,"independent");assert.deepEqual(s.entities,before);
    await page.evaluate(async()=>{const t=window.splineCheck;await t.sketch.constraints.add("fix",{points:t.state.splines[0].fitPoints.map(p=>p.point)});await t.reload();});
    const tip= s.entities.find(e=>e.reference.id===node.outgoing.id).geometry.position;
    await page.mouse.move(...await screen(tip));await page.mouse.down();await page.mouse.move(...await screen([-12,4]),{steps:5});await page.mouse.up();await idle();
    s=await state();const moved=s.entities.find(e=>e.reference.id===node.outgoing.id).geometry.position;
    assert.ok(Math.hypot(moved[0]+12,moved[1]-4)<1e-5);
    assert.deepEqual(s.entities.find(e=>e.reference.id===node.incoming.id).geometry,before.find(e=>e.reference.id===node.incoming.id).geometry);
    for (const mode of ["aligned","independent","aligned","independent"]) {
      const previous=s.entities;
      await page.mouse.dblclick(...await screen([-18,0]));await idle();
      s=await state();assert.equal(s.splines[0].fitPoints[1].mode,mode);
      if (mode==="independent") assert.deepEqual(s.entities,previous);
      else {
        const a=s.entities.find(e=>e.reference.id===node.incoming.id).geometry.position;
        const b=s.entities.find(e=>e.reference.id===node.outgoing.id).geometry.position;
        const c=s.entities.find(e=>e.reference.id===node.point.id).geometry.position;
        const u=[a[0]-c[0],a[1]-c[1]],v=[b[0]-c[0],b[1]-c[1]];
        assert.ok(Math.abs(u[0]*v[1]-u[1]*v[0])<1e-6);
        assert.ok(u[0]*v[0]+u[1]*v[1]<0);
        assert.ok(Math.abs(Math.hypot(...u)-Math.hypot(...v))>0.1,"Alignment must not equalize handle lengths");
      }
    }
    await choose();await click([-8,-12]);await click([3,-4]);await click([8,-12]);await finish();
    s=await state();assert.equal(s.splines.length,2);const second=s.splines.find(c=>c.curve.id!==first.curve.id);
    assert.equal(second.fitPoints[0].point.id,first.fitPoints.at(-1).point.id);
    await choose();await click([8,-28]);await click([18,-20]);await click([8,-12]);
    s=await state();assert.equal(s.splines.length,3,"Clicking an existing endpoint finishes and connects the curve");
    const third=s.splines.find(c=>![first.curve.id,second.curve.id].includes(c.curve.id));
    assert.equal(third.fitPoints.at(-1).point.id,second.fitPoints.at(-1).point.id);
    assert.equal(s.entities.filter(e=>e.reference.id===second.fitPoints.at(-1).point.id).length,1);
    await choose();await click([-28,15]);await click([-18,24]);await click([-8,15]);await click([-28,15]);
    s=await state();const closed=s.entities.find(e=>e.geometry.type==="spline"&&e.geometry.closed);
    assert.ok(closed);assert.equal(closed.geometry.points.length,3);
    await choose("Control points");await click([-44,15]);await click([-38,22]);await click([-32,8]);await click([-24,15]);await finish();
    s=await state();const control=s.splines.find(c=>!c.fitPoints.length);assert.equal(control.envelope.length,3);
    await page.keyboard.press("Escape");await page.evaluate(r=>{const t=window.splineCheck;t.selected.clear();t.selected.add(r.id);t.selectionChanged();},control.envelope[0]);
    assert.equal(await page.getByRole("button",{name:"Normal geometry",exact:true}).isEnabled(),false);
    await page.screenshot({path:"/private/tmp/pamatcad-spline-handles.png"});

    const fixtures=await page.evaluate(async()=>{
      const t=window.splineCheck,s=t.sketch;
      const a=await s.primitives.add("spline",{points:[[0,20],[6,25],[12,20]]});
      const b=await s.primitives.add("spline",{points:[[15,20],[20,25],[24,20]]});
      const c=await s.primitives.add("spline",{points:[[-44,8],[-40,14],[-35,8]],fit:true});
      const d=await s.primitives.add("spline",{points:[[-35,8],[-30,14],[-25,8]],fit:true});
      t.selected.clear();await t.reload();return {a,b,c,d};
    });
    await page.evaluate(id=>{const t=window.splineCheck;t.selected.add(id);t.selectionChanged();},fixtures.a.points[2].id);
    await page.mouse.move(...await screen([12,20]));await page.mouse.down();await page.mouse.move(...await screen([15,20]),{steps:6});await page.mouse.up();await idle();
    s=await state();assert.ok(!s.entities.some(e=>e.reference.id===fixtures.a.points[2].id));
    const curve=s.entities.find(e=>e.reference.id===fixtures.a.id);assert.equal(curve.geometry.points.at(-1),fixtures.b.points[0].id);
    assert.deepEqual(await page.evaluate(()=>[...window.splineCheck.selected]),[fixtures.b.points[0].id]);
    await page.evaluate(({c,d})=>{const t=window.splineCheck;t.selected.clear();[c.points[2],d.points[0]].forEach(r=>t.selected.add(r.id));t.selectionChanged();},fixtures);
    await page.locator('[data-constraint="coincident"]').click();await idle();
    assert.ok(!(await state()).entities.some(e=>e.reference.id===fixtures.c.points[2].id));
    console.log("Spline handles: drawing, repeated double-click mode toggles, independent lengths, constraints, shared drawing/drag/Coincident joins, closure and control polygon passed");
  }catch(error){await page.screenshot({path:"/private/tmp/pamatcad-spline-failure.png"});throw error;}
  finally{await page.evaluate(()=>window.splineCheck.escape());await idle();await page.locator("#cancel").click();}
}

export async function testSplineCurveDragging(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addScriptTag({ path: "tests/editor/rectangle.js" });
  for (const fit of [false, true]) for (const closed of [false, true]) {
    await page.getByText("File", { exact: true }).click(); await page.locator("#menu-new").click();
    await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
    await page.evaluate(async () => {
      const { SketchTool } = await import("/src/tools/sketch.ts"), start = SketchTool.prototype.start;
      SketchTool.prototype.start = function (...args) { window.splineDragCheck = { tool: this }; return start.apply(this, args); };
      try { document.querySelector("#new-sketch").click(); } finally { SketchTool.prototype.start = start; }
    });
    await page.evaluate(() => chooseSketchPlane("XY"));
    const idle = () => page.waitForFunction(() => {
      const t = window.splineDragCheck.tool;
      return t.state && !t.pending && !t.updateRunning && !t.dragQueued && !t.viewport.renderPending;
    });
    await idle();
    try {
      const setup = await page.evaluate(async ({ fit, closed }) => {
        const check = window.splineDragCheck, t = check.tool, s = t.sketch;
        const curve = await s.primitives.add("spline", { fit, closed, points: closed ? [[-20, -10], [0, -20], [20, -10], [12, 15], [-12, 15]] : [[-20, -5], [-10, 15], [10, -12], [20, 3]] });
        const unrelated = await s.primitives.add("point", { position: [-30, 25] });
        await t.reload(); t.choose("select"); t.viewport.span = 80; t.viewport.resize(); t.viewport.alignSketch();
        const g = t.state.entities.find(e => e.reference.id === curve.id).geometry, spline = t.state.splines.find(s => s.curve.id === curve.id);
        const ids = new Set([...g.points, ...spline.fitPoints.flatMap(n => [n.incoming, n.outgoing].filter(Boolean).map(r => r.id))]);
        check.points = [...ids].map(id => t.state.entities.find(e => e.reference.id === id));
        check.curve = curve; check.calls = []; check.original = s.drag.bind(s);
        s.drag = async (...args) => {
          check.calls.push(args);
          const result = await check.original(...args);
          if (check.holdNext) { check.holdNext = false; await new Promise(resolve => { check.release = resolve; }); }
          return result;
        };
        return { curve, unrelated, state: t.state, points: check.points, view: t.viewport.captureView() };
      }, { fit, closed });
      const curvePoint = () => page.evaluate(() => {
        const { tool: t, curve } = window.splineDragCheck, v = t.viewport;
        v.renderFrame(); const r = v.host.getBoundingClientRect(), panel = document.querySelector("#tool-panel").getBoundingClientRect();
        const points = t.proxy.curves.find(c => c.entity.id === curve.id).points;
        const indices = points.map((_, i) => i).sort((a, b) => Math.abs(a - points.length / 2) - Math.abs(b - points.length / 2));
        for (const i of indices) {
          const p = v.camera.position.clone().fromArray(points[i]).project(v.camera);
          const clientX = Math.round(r.x + (p.x + 1) * r.width / 2), clientY = Math.round(r.y + (1 - p.y) * r.height / 2);
          if (clientX >= panel.left && clientX <= panel.right && clientY >= panel.top && clientY <= panel.bottom) continue;
          if (clientY < r.top + 30 || clientY > r.bottom - 30 || clientX < r.left + 30 || clientX > r.right - 30) continue;
          if (v.sketchPicks({ clientX, clientY })[0]?.id === curve.id) return [clientX, clientY];
        }
        throw new Error("No unobstructed spline curve sample");
      });
      let p = await curvePoint();
      await page.mouse.click(...p); await idle();
      assert.deepEqual(await page.evaluate(() => [...window.splineDragCheck.tool.selected]), [setup.curve.id]);
      assert.equal(await page.evaluate(() => window.splineDragCheck.calls.length), 0);
      assert.equal(await page.evaluate(() => window.splineDragCheck.tool.state.revision), setup.state.revision);
      const delta = await page.evaluate(p => {
        const v = window.splineDragCheck.tool.viewport, a = v.point({ clientX: p[0], clientY: p[1] }), b = v.point({ clientX: p[0] + 28, clientY: p[1] - 18 });
        return [b[0] - a[0], b[1] - a[1]];
      }, p);
      await page.evaluate(() => { window.splineDragCheck.holdNext = true; });
      await page.mouse.move(...p); await page.mouse.down();
      const excluded = await page.evaluate(() => [...window.splineDragCheck.tool.dragExcluded]);
      assert.ok(setup.points.every(point => excluded.includes(point.reference.id)), "All spline points and tangent tips are excluded from self-snapping");
      await page.mouse.move(p[0] + 2, p[1] - 2);
      await page.waitForFunction(() => !!window.splineDragCheck.release);
      await page.mouse.move(p[0] + 28, p[1] - 18, { steps: 8 }); await page.mouse.up();
      assert.equal(await page.evaluate(() => window.splineDragCheck.calls.length), 1);
      assert.equal(await page.locator("#apply").isDisabled(), true);
      await page.evaluate(() => window.splineDragCheck.release()); await idle();
      const after = await page.evaluate(() => ({ state: window.splineDragCheck.tool.state, calls: window.splineDragCheck.calls, view: window.splineDragCheck.tool.viewport.captureView() }));
      assert.equal(after.calls.length, 2, "Only the latest queued target survives release");
      for (const point of setup.points) {
        const actual = after.state.entities.find(e => e.reference.id === point.reference.id).geometry.position;
        const expected = point.geometry.position.map((n, axis) => n + delta[axis]);
        assert.ok(Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) < 1e-6, `Whole ${fit ? "fit" : "control"} spline translates ${point.reference.id}`);
      }
      assert.deepEqual(after.state.splines, setup.state.splines); assert.deepEqual(after.state.constraints, setup.state.constraints);
      assert.deepEqual(after.view, setup.view);
      assert.deepEqual(after.state.entities.find(e => e.reference.id === setup.unrelated.points[0].id), setup.state.entities.find(e => e.reference.id === setup.unrelated.points[0].id));
      assert.equal(await page.locator("#apply").isDisabled(), false);
      await page.evaluate(async () => { const c = window.splineDragCheck; await c.original(...c.calls.at(-1)); await c.tool.reload(); });
      assert.deepEqual(await page.evaluate(() => window.splineDragCheck.tool.state.entities), after.state.entities);
      // A fixed node restricts the same whole-curve gesture, without disabling it.
      const fixed = await page.evaluate(async () => {
        const c = window.splineDragCheck, t = c.tool, ref = c.curve.points[0];
        await t.sketch.constraints.add("fix", { points: [ref] }); await t.reload();
        c.calls = []; return { ref, position: t.state.entities.find(e => e.reference.id === ref.id).geometry.position };
      });
      p = await curvePoint();
      await page.mouse.move(...p); await page.mouse.down(); await page.mouse.move(p[0] + 12, p[1] - 10, { steps: 5 }); await page.mouse.up(); await idle();
      const constrained = await page.evaluate(ref => ({ point: window.splineDragCheck.tool.state.entities.find(e => e.reference.id === ref.id).geometry.position,
        calls: window.splineDragCheck.calls.length, error: document.querySelector("#sketch-error").textContent }), fixed.ref);
      assert.deepEqual(constrained.point, fixed.position); assert.ok(constrained.calls > 0); assert.equal(constrained.error, "");
      await page.screenshot({ path: `/private/tmp/pamatcad-${fit ? "fit" : "control"}-${closed ? "closed" : "open"}-spline-drag.png` });
      await page.locator("#apply").click(); await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
    } finally { await page.evaluate(() => { if (window.splineDragCheck.release) window.splineDragCheck.release(); delete window.splineDragCheck; }); }
  }
  console.log("Whole spline dragging: fit/control, open/closed, real curve gestures, absolute queued/release targets, fixed nodes, self-snapping exclusions and camera preservation passed");
}
