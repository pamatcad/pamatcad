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
