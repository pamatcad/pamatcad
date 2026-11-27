import assert from "node:assert/strict";

export async function testConnectedSelection(page) {
  const originalViewport=page.viewportSize();await page.setViewportSize({width:1440,height:1000});
  await page.getByText("File",{exact:true}).click();await page.locator("#menu-new").click();
  await page.waitForFunction(()=>!document.querySelector("#new-sketch").disabled);
  await page.evaluate(async()=>{
    const {SketchTool}=await import("/src/tools/sketch.ts"),start=SketchTool.prototype.start;
    const lifetime=new AbortController();
    window.connectedCheck={restore:()=>{SketchTool.prototype.start=start;lifetime.abort();}};
    SketchTool.prototype.start=function(...args){window.connectedCheck.tool=this;return start.apply(this,args);};
    document.querySelector("#model-canvas").addEventListener("dblclick",e=>{const c=window.connectedCheck;if(c)c.last={picks:c.tool.viewport.sketchPicks(e),pending:c.tool.pending};},{capture:true,signal:lifetime.signal});
  });
  const idle=()=>page.waitForFunction(()=>{const t=window.connectedCheck.tool;return t?.state&&!t.pending&&!t.updateRunning&&!t.previewQueued&&!t.creating&&!t.viewport.renderPending;});
  const selected=()=>page.evaluate(()=>[...window.connectedCheck.tool.selected].sort());
  const ids=(...groups)=>[...new Set(groups.flatMap(g=>[...g.points,...g.curves].map(r=>r.id)))].sort();
  const screen=xy=>page.evaluate(xy=>{
    const t=window.connectedCheck.tool,v=t.viewport,f=t.state.frame;v.camera.updateMatrixWorld();
    const p=v.camera.position.clone().fromArray(f.origin).addScaledVector(v.camera.position.clone().fromArray(f.u),xy[0]).addScaledVector(v.camera.position.clone().fromArray(f.v),xy[1]).project(v.camera),r=document.querySelector("#model-canvas").getBoundingClientRect();
    return [r.x+(p.x+1)*r.width/2,r.y+(1-p.y)*r.height/2];
  },xy);
  const double=async xy=>{await page.mouse.dblclick(...await screen(xy));await idle();};
  const clear=async()=>{await page.evaluate(()=>{const t=window.connectedCheck.tool;t.choose("select");t.selected.clear();t.selectionChanged();document.querySelectorAll(".sketch-popup").forEach(e=>e.remove());});await idle();};
  const curveSample=id=>page.evaluate(id=>{
    const t=window.connectedCheck.tool,v=t.viewport,r=document.querySelector("#model-canvas").getBoundingClientRect();v.renderFrame();
    const path=t.proxy.curves.find(c=>c.entity.id===id).points;
    for(const p of path.slice(1,-1).sort((a,b)=>Math.hypot(...a)-Math.hypot(...b))){
      const q=v.camera.position.clone().fromArray(p).project(v.camera),xy=[Math.round(r.x+(q.x+1)*r.width/2),Math.round(r.y+(1-q.y)*r.height/2)];
      const picks=v.sketchPicks({clientX:xy[0],clientY:xy[1]});
      if(picks.length===1&&picks[0].id===id)return xy;
    }
    throw new Error("No unambiguous curve sample: "+id);
  },id);
  try{
    await page.locator("#new-sketch").click();await page.evaluate(()=>chooseSketchPlane("XY"));await idle();
    const f=await page.evaluate(async()=>{
      const t=window.connectedCheck.tool,s=t.sketch;
      const slot=await s.primitives.add("slot",{from:[-30,18],to:[-12,18],radius:3});
      const square=await s.primitives.add("rectangle",{from:[8,14],to:[20,24]});
      const centered=await s.primitives.add("rectangle",{from:[32,17],to:[38,22],centered:true});
      const remote=await s.primitives.add("line",{from:[10,2],to:[28,2]});
      let state=await s.state();const side=slot.curves.find(r=>{const e=state.entities.find(e=>e.reference.id===r.id);return e.geometry.type==="line"&&!e.construction;});
      await s.constraints.add("equal",{curves:[side,remote.curves[0]]});
      const chain=[];for(const [from,to] of [[[-32,0],[-24,2]],[[-24,2],[-16,0]],[[-16,0],[-10,4]],[[-24,2],[-24,8]]])chain.push(await s.primitives.add("line",{from,to}));
      await s.constraints.add("coincident",{points:[chain[1].points[1],chain[2].points[0]]});
      const crossing=await s.primitives.add("line",{from:[-22,-6],to:[-22,6]});
      const junction=await s.primitives.add("line",{from:[-20,1],to:[-16,6]});
      await s.constraints.add("pointOnCurve",{points:[junction.points[0]],curves:chain[1].curves});chain.push(junction);
      const a=await s.primitives.add("spline",{points:[[-33,-20],[-27,-12],[-21,-20]],fit:true});
      const b=await s.primitives.add("spline",{points:[[-21,-20],[-15,-26],[-9,-20]],fit:true});
      await s.splines.join({from:a.points[2],to:b.points[0]});
      const c=await s.primitives.add("spline",{points:[[-9,-20],[-5,-12],[0,-12],[4,-20]],fit:false});
      await s.constraints.add("coincident",{points:[b.points[2],c.points[0]]});
      const stacked=[];for(const to of [[23,-5],[18,-5]])stacked.push(await s.primitives.add("line",{from:[8,-5],to}));
      const dots=[];for(let i=0;i<2;i++)dots.push(await s.primitives.add("point",{position:[28,-12]}));
      await t.reload();t.viewport.span=100;t.viewport.resize();t.viewport.alignSketch();
      state=t.state;
      const splines=state.splines.filter(p=>[a.id,b.id,c.id].includes(p.curve.id));
      const splineIds=[...new Set(splines.flatMap(p=>[p.curve.id,...p.envelope.map(r=>r.id),...state.entities.find(e=>e.reference.id===p.curve.id).geometry.points,...p.fitPoints.flatMap(n=>[n.point,n.incoming,n.outgoing].filter(Boolean).map(r=>r.id))]))].sort();
      return {slot,square,centered,remote,chain,crossing,a,b,c,stacked,dots,splineIds};
    });await idle();
    await double([-21,15]);assert.deepEqual(await selected(),ids(f.slot),"Slot includes construction centerline and midpoint, without following Equal");
    await double([8,14]);assert.deepEqual(await selected(),ids(f.square),"A joined corner is one connected target");
    await clear();await double([14,24]);assert.deepEqual(await selected(),ids(f.square));
    await page.keyboard.down("Shift");await double([-21,15]);await page.keyboard.up("Shift");assert.deepEqual(await selected(),ids(f.slot,f.square));
    await clear();await double([32,22]);assert.deepEqual(await selected(),ids(f.centered),"Centered rectangle includes diagonals and center");
    await clear();await double([-28,1]);assert.deepEqual(await selected(),ids(...f.chain),"Branches, touching endpoints, Coincident and Point-on-curve join; geometric crossings do not");
    await clear();await double([-24,2]);assert.deepEqual(await selected(),ids(...f.chain));
    await clear();await double([-20,1]);assert.deepEqual(await selected(),ids(...f.chain),"Explicit point-on-curve junction is unambiguous");
    await clear();await page.mouse.dblclick(...await curveSample(f.a.id));await idle();assert.deepEqual(await selected(),f.splineIds,"Connected fit and control splines include their handles");
    await clear();await page.mouse.dblclick(...await curveSample(f.c.id));await idle();assert.deepEqual(await selected(),f.splineIds);
    console.log("Connected selection: slots, rectangle corners/helpers, Shift-add, branched chains, explicit junctions and fit/control splines passed");

    for(const xy of [[13,-5],[8,-5],[28,-12],[-22,1.5]]){
      await clear();await double(xy);const choices=page.locator(".sketch-popup button");assert.ok(await choices.count()>=2,"Distinct layered targets keep the chooser");
      const text=await choices.first().textContent();await choices.first().click();await idle();assert.deepEqual(await selected(),[text.split(" · ")[1]],"Picker selects one item");
    }
    await clear();await page.evaluate(()=>{const t=window.connectedCheck.tool;t.options.construction=false;t.options.points=false;t.display();});await idle();
    await double([-21,15]);assert.deepEqual(await selected(),ids(f.slot));
    await clear();await double([8,14]);assert.deepEqual(await selected(),ids(f.square),"Corners work with points hidden");
    await page.evaluate(()=>{const t=window.connectedCheck.tool;t.options.construction=true;t.options.points=true;t.viewport.span=80;t.viewport.resize();t.display();});await idle();
    await clear();await double([-28,1]);assert.deepEqual(await selected(),ids(...f.chain));
    console.log("Connected selection: layered spans/points/crossings, single-item picker, hidden helpers and zoom passed");

    await clear();await page.locator('[data-tool="move"]').click();await idle();
    await double([-21,15]);assert.deepEqual(await selected(),ids(f.slot),"Move's first-click previews do not swallow double-click");
    const before=await page.evaluate(()=>window.connectedCheck.tool.state.entities);
    for(const [id,value] of [["sketch-move-x","4 mm"],["sketch-move-y","3 mm"]]){
      await page.locator(`button[data-handle="${id}"]`).click();await page.locator(`#${id}`).fill(value);await idle();await page.locator(`#${id}`).press("Enter");await idle();
    }
    assert.equal(await page.locator("#sketch-error").textContent(),"");await page.locator("#sketch-action").click();await idle();
    const after=await page.evaluate(()=>window.connectedCheck.tool.state.entities);
    for(const ref of f.slot.points){const old=before.find(e=>e.reference.id===ref.id).geometry.position,p=after.find(e=>e.reference.id===ref.id).geometry.position;assert.ok(Math.hypot(p[0]-old[0]-4,p[1]-old[1]-3)<1e-6,ref.id);}
    for(const e of before.filter(e=>!ids(f.slot).includes(e.reference.id)))assert.deepEqual(after.find(a=>a.reference.id===e.reference.id),e);
    for(const e of before.filter(e=>e.geometry.type==="arc"))assert.equal(after.find(a=>a.reference.id===e.reference.id).geometry.radius,e.geometry.radius);
    console.log("Connected selection: a whole slot moves through the combined Move control, including its midpoint, with unrelated geometry unchanged");

    await clear();
    const marker=()=>page.evaluate(id=>{
      const t=window.connectedCheck.tool,node=t.state.splines.find(s=>s.curve.id===id).fitPoints[1];
      const m=t.viewport.sketchDisplay.children.find(o=>o.isPoints&&o.userData.pick?.id===node.point.id),canvas=m.material.map.image;
      return {mode:node.mode,corner:canvas.getContext("2d").getImageData(5,5,1,1).data[3],center:canvas.getContext("2d").getImageData(16,16,1,1).data[3],size:m.material.size,color:m.material.color.getHex()};
    },f.a.id);
    assert.equal((await marker()).corner,0);
    await double([-27,-12]);let squareMarker=await marker();assert.equal(squareMarker.mode,"independent");assert.equal(squareMarker.corner,255);assert.equal(squareMarker.center,255);
    await double([-27,-12]);const roundMarker=await marker();assert.equal(roundMarker.mode,"aligned");assert.equal(roundMarker.corner,0);assert.equal(roundMarker.size,squareMarker.size);assert.equal(roundMarker.color,squareMarker.color);
    await double([-21,-20]);assert.equal(await page.evaluate(id=>{const s=window.connectedCheck.tool.state;return s.splines.filter(c=>c.fitPoints.some(n=>n.point.id===id&&n.mode==="independent")).length;},f.b.points[0].id),2,"A shared fit knot changes both owning splines");
    await double([-27,-12]);
    await page.evaluate(async()=>{
      const {editorTheme,lightTheme}=await import("/src/theme.ts");editorTheme.set({...lightTheme,colors:{...lightTheme.colors,geometrySelected:"#123456"}});
      const v=window.connectedCheck.tool.viewport;window.connectedCheck.view=v.captureView();v.renderer.setPixelRatio(2);v.restoreView({...window.connectedCheck.view,mode:"perspective",position:[30,45,120],target:[0,0,0],up:[0,1,0],zoom:1.4});
    });await idle();assert.equal((await marker()).corner,255);assert.equal((await marker()).color,0x123456);assert.equal((await marker()).size,squareMarker.size);
    await page.evaluate(async()=>{const {editorTheme,lightTheme}=await import("/src/theme.ts");editorTheme.set(lightTheme);window.connectedCheck.tool.viewport.restoreView(window.connectedCheck.view);});await idle();
    await double([-27,-12]);assert.equal((await marker()).corner,0);await double([-27,-12]);assert.equal((await marker()).corner,255);
    await page.evaluate(()=>window.connectedCheck.tool.viewport.renderer.setPixelRatio(devicePixelRatio));
    await page.evaluate(async()=>{const t=window.connectedCheck.tool;await t.sketch.primitives.add("point",{position:[-27,-12]});await t.reload();});await idle();
    await double([-27,-12]);assert.ok(await page.locator(".sketch-popup button").count()>=2);assert.equal((await marker()).mode,"independent","An unrelated overlapping point opens the chooser instead of toggling");
    await clear();await page.mouse.move(40,100);await page.screenshot({path:"/private/tmp/pamatcad-connected-selection.png"});
    await page.locator("#apply").click();await page.waitForFunction(()=>!document.querySelector("#new-sketch").disabled);
    await page.locator("#features li").first().dblclick();await idle();
    assert.equal((await marker()).mode,"independent");assert.equal((await marker()).corner,255);
    await double([-17,18]);assert.deepEqual(await selected(),ids(f.slot),"Reopening rebuilds connectivity from the current document");
    console.log("Spline point styles: round/aligned, square/independent, shared knots, overlapping points, unchanged size/color, theme/view/density and Finish/reopen passed");
  }catch(error){console.error(JSON.stringify(await page.evaluate(()=>({selected:[...window.connectedCheck.tool.selected],last:window.connectedCheck.last,mode:window.connectedCheck.tool.tool,error:document.querySelector("#sketch-error")?.textContent}))));await page.screenshot({path:"/private/tmp/pamatcad-connected-failure.png"});throw error;}
  finally{await page.evaluate(async()=>{const {editorTheme,lightTheme}=await import("/src/theme.ts");editorTheme.set(lightTheme);window.connectedCheck.tool.viewport.renderer.setPixelRatio(devicePixelRatio);window.connectedCheck.restore();window.connectedCheck.tool.escape();delete window.connectedCheck;});await page.setViewportSize(originalViewport);}
}

export async function testSketchProjections(page) {
  const originalViewport=page.viewportSize();await page.setViewportSize({width:1440,height:1000});
  await page.getByText("File",{exact:true}).click();await page.locator("#menu-new").click();
  await page.waitForFunction(()=>!document.querySelector("#new-sketch").disabled);
  await page.evaluate(async()=>{
    const {SketchTool}=await import("/src/tools/sketch.ts"),start=SketchTool.prototype.start;
    window.projectionCheck={restore:()=>SketchTool.prototype.start=start};
    SketchTool.prototype.start=function(...args){window.projectionCheck.tool=this;return start.apply(this,args);};
  });
  const idle=()=>page.waitForFunction(()=>{const t=window.projectionCheck.tool;return t.state&&!t.pending&&!t.updateRunning&&!t.previewQueued&&!t.creating&&!t.viewport.renderPending;});
  const screen=xy=>page.evaluate(xy=>{
    const t=window.projectionCheck.tool,v=t.viewport,f=t.state.frame;v.camera.updateMatrixWorld();
    const p=v.camera.position.clone().fromArray(f.origin).addScaledVector(v.camera.position.clone().fromArray(f.u),xy[0]).addScaledVector(v.camera.position.clone().fromArray(f.v),xy[1]).project(v.camera),r=document.querySelector("#model-canvas").getBoundingClientRect();
    return [r.x+(p.x+1)*r.width/2,r.y+(1-p.y)*r.height/2];
  },xy);
  try{
    await page.locator("#new-sketch").click();await page.evaluate(()=>chooseSketchPlane("XY"));await idle();
    await page.evaluate(async()=>{const t=window.projectionCheck.tool;await t.sketch.primitives.add("circle",{center:[-10,0],diameter:20});await t.reload();});await idle();
    await page.locator("#apply").click();await page.waitForFunction(()=>!document.querySelector("#extrude").disabled);
    await page.locator("#extrude").click();await page.locator("#length").fill("8 mm");await page.waitForFunction(()=>!document.querySelector("#apply").disabled);
    await page.locator("#apply").click();await page.waitForFunction(()=>document.querySelector("#features").children.length===2&&!document.querySelector("#new-sketch").disabled);
    await page.locator("#new-sketch").click();await page.evaluate(()=>chooseSketchPlane("XY"));await idle();
    await page.locator('[data-tool="project"]').click();await page.mouse.click(...await screen([-10,10]));await idle();
    const circle=await page.evaluate(()=>{const t=window.projectionCheck.tool;return t.state.entities.find(e=>e.projected&&e.geometry.type==="circle");});
    assert.ok(circle,"Picking a cylinder rim projects an analytic circle");
    assert.equal(await page.evaluate(()=>window.projectionCheck.tool.state.entities.filter(e=>e.projected).length),2);
    await page.keyboard.press("Escape");await idle();
    await page.mouse.click(...await screen([-10,0]));await idle();assert.deepEqual(await page.evaluate(()=>[...window.projectionCheck.tool.selected]),[circle.geometry.center]);
    await page.evaluate(async()=>{const t=window.projectionCheck.tool,line=await t.sketch.primitives.add("line",{from:[-22,12],to:[2,12],construction:true});await t.sketch.constraints.add("horizontal",{curves:line.curves});await t.reload();});await idle();
    await page.mouse.click(...await screen([-20,12]));await page.keyboard.down("Shift");await page.mouse.click(...await screen([-10,-10]));await page.keyboard.up("Shift");await idle();
    await page.locator('[data-constraint="tangent"]').click();await idle();
    assert.equal(await page.locator("#sketch-error").textContent(),"");assert.equal(await page.evaluate(()=>window.projectionCheck.tool.state.constraints.filter(c=>c.kind==="tangent").length),1);
    await page.keyboard.press("Escape");await page.locator('[data-tool="dimension"]').click();
    await page.mouse.click(...await screen([-10,-10]));await page.mouse.click(...await screen([-25,-12]));
    const field=page.getByRole("textbox",{name:"Dimension formula",exact:true});await field.waitFor({state:"visible"});await field.fill("10 mm");await field.press("Enter");await idle();
    assert.equal(await page.locator("#sketch-error").textContent(),"");
    const radius=await page.evaluate(()=>window.projectionCheck.tool.state.dimensions.find(d=>d.kind==="radius"));assert.ok(radius);assert.equal(radius.parameters.curve.id,circle.reference.id);assert.equal(radius.parameters.mode,"driven");assert.equal(radius.computed.value,10);
    await page.keyboard.press("Escape");await page.mouse.move(40,100);await page.screenshot({path:"/private/tmp/pamatcad-circle-projection.png"});
    console.log("Projection: cylinder rim picking, one circle/center, center selection, Tangent and driven radius passed");
  }catch(error){console.error(await page.evaluate(()=>({state:window.projectionCheck.tool.state,selection:[...window.projectionCheck.tool.selected],error:document.querySelector('#sketch-error')?.textContent})));await page.screenshot({path:"/private/tmp/pamatcad-projection-failure.png"});throw error;}
  finally{await page.evaluate(()=>{window.projectionCheck.restore();window.projectionCheck.tool.escape();delete window.projectionCheck;});await page.setViewportSize(originalViewport);}
}

export async function testMoveControl(page) {
  const originalViewport = page.viewportSize();
  await page.setViewportSize({width:1440,height:1000});
  await page.getByText("File",{exact:true}).click(); await page.locator("#menu-new").click();
  await page.waitForFunction(()=>!document.querySelector("#new-sketch").disabled);
  await page.evaluate(async()=>{
    const {SketchTool}=await import("/src/tools/sketch.ts"), start=SketchTool.prototype.start;
    SketchTool.prototype.start=function(...args){window.moveCheck={tool:this};return start.apply(this,args);};
    try{document.querySelector("#new-sketch").click();}finally{SketchTool.prototype.start=start;}
  });
  await page.evaluate(()=>chooseSketchPlane("XY"));
  const idle=()=>page.waitForFunction(()=>{const t=window.moveCheck.tool;return t.state&&!t.pending&&!t.updateRunning&&!t.previewQueued&&!t.creating&&!t.viewport.renderPending;});
  const select=async(refs,mode="move")=>{await page.evaluate(({refs,mode})=>{const t=window.moveCheck.tool;t.choose("select");t.selected.clear();refs.forEach(r=>t.selected.add(r.id));t.choose(mode);},{refs,mode});await idle();};
  const control=id=>page.locator(`button[data-handle="${id}"]`);
  const center=async id=>{const r=await control(id).boundingBox();assert.ok(r,id);return [r.x+r.width/2,r.y+r.height/2];};
  const snapshot=()=>page.evaluate(()=>{const t=window.moveCheck.tool;return {values:t.moveAccepted.values,entities:t.state.entities,preview:t.editPreview?.entities,origin:t.viewport.handles.items[0]?.origin,fields:[...t.liveDimensions.querySelectorAll("[data-move-field]")].filter(e=>e.getClientRects().length).map(e=>e.dataset.moveField),error:t.get("sketch-error").textContent};});
  const drag=async(id,dx,dy)=>{const p=await center(id);await page.mouse.move(...p);await page.mouse.down();await page.mouse.move(p[0]+dx,p[1]+dy,{steps:5});await page.mouse.up();await idle();};
  const x=page.locator("#sketch-move-x"),y=page.locator("#sketch-move-y"),angle=page.locator("#sketch-angle");
  try {
    await idle();
    const refs=await page.evaluate(async()=>{
      const t=window.moveCheck.tool,s=t.sketch;
      const line=await s.primitives.add("line",{from:[-15,-10],to:[15,10]});
      const horizontal=await s.primitives.add("line",{from:[-20,22],to:[10,22]});
      await s.constraints.add("horizontal",{curves:horizontal.curves});
      const fixed=await s.primitives.add("circle",{center:[-25,-20],diameter:8});
      const anchor=await s.primitives.add("point",{position:[-25,-20]});
      await s.constraints.add("fix",{points:anchor.points});
      await s.constraints.add("coincident",{points:[fixed.points[0],anchor.points[0]]});
      const measured=await s.dimensions.add("length",{line:horizontal.curves[0],mode:"driven",annotation:{position:[-5,28]}});
      await t.reload();return {line,horizontal,fixed,measured};
    });
    await select(refs.line.curves);
    assert.equal(await page.locator("button.tool-move-access").count(),4);
    assert.deepEqual((await snapshot()).fields,[]);
    assert.equal(await page.locator("#sketch-pivot svg").count(),1);
    await control("sketch-move-x").click();await idle();
    assert.deepEqual((await snapshot()).fields,["sketch-move-x"]);
    assert.equal(await x.inputValue(),"0 mm");
    await x.fill("12.5 mm / 2");await idle();assert.deepEqual((await snapshot()).values,[6.25,0,0]);
    await x.press("Enter");await idle();assert.deepEqual((await snapshot()).fields,[]);
    await control("sketch-move-x").click();await idle();assert.deepEqual((await snapshot()).values,[6.25,0,0],"Clicking a handle does not snap a typed value");await x.press("Enter");
    await control("sketch-move-y").focus();await page.keyboard.press("Enter");assert.equal(await y.evaluate(e=>document.activeElement===e),true);
    assert.equal(await y.inputValue(),"0 mm");await y.fill(`sketches[${refs.horizontal.curves[0].sketchId}]dimension[${refs.measured.id}] / 7.5`);await idle();await y.press("Enter");await idle();
    assert.deepEqual((await snapshot()).values,[6.25,4,0]);
    await control("sketch-angle").click();await angle.fill("30 deg / 2");await idle();await angle.press("Enter");await idle();
    assert.deepEqual((await snapshot()).values,[6.25,4,15]);
    const translated=await snapshot();
    assert.notDeepEqual(translated.preview,translated.entities,"Preview does not commit geometry");
    await page.locator("#sketch-action").click();await idle();
    assert.deepEqual((await snapshot()).entities,translated.preview);
    assert.deepEqual((await snapshot()).values,[0,0,0]);
    assert.equal(await page.locator("#sketch-action").isDisabled(),true,"Apply waits for a new valid selection/preview");
    console.log("Move: contextual X/Y/angle formulas, units, keyboard entry and combined Apply passed");

    await select(refs.line.curves);
    const before=await snapshot();
    await page.evaluate(()=>{const c=window.moveCheck,t=c.tool,transform=t.sketch.transform.bind(t.sketch);c.calls=[];c.restore=()=>t.sketch.transform=transform;t.sketch.transform=async options=>{c.calls.push(options);const result=await transform(options);if(c.hold&&options.preview){c.hold=false;await new Promise(resolve=>c.release=resolve);}return result;};c.hold=true;});
    const p=await center("sketch-move-x");await page.mouse.move(...p);await page.mouse.down();await page.mouse.move(p[0]+25,p[1]);await page.waitForFunction(()=>!!window.moveCheck.release);
    await page.mouse.move(p[0]+55,p[1]);
    assert.deepEqual((await snapshot()).values,before.values);assert.deepEqual((await snapshot()).origin,before.origin);assert.equal(await x.inputValue(),"0 mm");
    await page.mouse.up();await page.evaluate(()=>window.moveCheck.release());await idle();
    const moved=await snapshot();assert.ok(moved.values[0]>0);assert.deepEqual(moved.entities,before.entities);
    assert.ok((await page.evaluate(()=>window.moveCheck.calls)).every(c=>c.preview));
    await page.evaluate(()=>window.moveCheck.restore());
    await drag("sketch-move-y",0,-30);assert.ok((await snapshot()).values[1]>0);
    const xyBefore=await snapshot();await drag("sketch-move-xy",30,25);
    const xyAfter=await snapshot();assert.ok(xyAfter.values[0]>xyBefore.values[0]&&xyAfter.values[1]<xyBefore.values[1]);
    assert.deepEqual(xyAfter.fields,["sketch-move-x","sketch-move-y"]);
    await x.focus();await x.press("Enter");assert.equal(await y.evaluate(e=>document.activeElement===e),true);await y.press("Enter");await idle();assert.deepEqual((await snapshot()).fields,[]);
    const cancelStart=await snapshot(),q=await center("sketch-move-x");await page.mouse.move(...q);await page.mouse.down();await page.mouse.move(q[0]+40,q[1]);await idle();
    await page.evaluate(()=>{const t=window.moveCheck.tool;document.querySelector("#model-canvas").dispatchEvent(new PointerEvent("pointercancel",{pointerId:t.viewport.handles.drag.pointer,button:0,bubbles:true}));});
    await page.mouse.up();await idle();assert.deepEqual((await snapshot()).values,cancelStart.values);assert.deepEqual((await snapshot()).preview,cancelStart.preview);
    await page.keyboard.press("Escape");await idle();assert.deepEqual((await snapshot()).entities,before.entities);
    console.log("Move: X/Y/XY dragging, delayed/coalesced previews, pointer cancellation and Escape passed");

    await select(refs.line.curves);
    const rotation=await page.evaluate(()=>{const t=window.moveCheck.tool,v=t.viewport,h=v.handles.items[0],r=document.querySelector("#model-canvas").getBoundingClientRect();const p=v.camera.position.clone().fromArray(h.origin).project(v.camera);return [r.x+(p.x+1)*r.width/2,r.y+(1-p.y)*r.height/2];});
    const grip=await center("sketch-angle");await page.mouse.move(...grip);await page.mouse.down();
    for(let a=60;a<=315;a+=15)await page.mouse.move(rotation[0]+64*Math.cos(a*Math.PI/180),rotation[1]-64*Math.sin(a*Math.PI/180));
    await page.mouse.up();await idle();assert.equal((await snapshot()).values[2],270);
    assert.deepEqual((await snapshot()).fields,["sketch-angle"]);
    await page.keyboard.press("Escape");await idle();
    await select(refs.horizontal.curves);await drag("sketch-move-x",35,0);
    const accepted=await snapshot();assert.ok(accepted.values[0]>0);assert.equal(accepted.error,"");
    await control("sketch-angle").click();await angle.fill("30 deg");await idle();
    const rejected=await snapshot();assert.match(rejected.error,/constraints prevent/i);assert.deepEqual(rejected.values,accepted.values);assert.deepEqual(rejected.origin,accepted.origin);assert.deepEqual(rejected.preview,accepted.preview);assert.equal(await angle.inputValue(),"0 deg");
    await select(refs.fixed.curves);const fixed=await snapshot();await drag("sketch-move-xy",40,-30);
    const denied=await snapshot();assert.match(denied.error,/constraints prevent/i);assert.deepEqual(denied.values,fixed.values);assert.deepEqual(denied.origin,fixed.origin);assert.deepEqual(denied.preview,fixed.preview);
    await page.evaluate(()=>{const t=window.moveCheck.tool;t.pivot=[-25,-20];t.choose("move");});await idle();
    await control("sketch-angle").click();await angle.fill("90 deg");await idle();assert.equal((await snapshot()).error,"");
    const acceptedPivot=await snapshot();await page.locator("#sketch-pivot").click();
    const pivotCanvas=await page.locator("#model-canvas").boundingBox();await page.mouse.click(pivotCanvas.x+100,pivotCanvas.y+100);await idle();
    assert.match((await snapshot()).error,/constraints prevent/i);assert.deepEqual((await snapshot()).origin,acceptedPivot.origin);assert.deepEqual((await snapshot()).values,acceptedPivot.values);assert.deepEqual((await snapshot()).preview,acceptedPivot.preview);
    console.log("Move: unrestricted rotation and rejected moves retain accepted handles, values and geometry");

    await select(refs.line.curves);
    await page.locator("#sketch-pivot").click();assert.equal(await page.locator("#sketch-pivot").getAttribute("aria-pressed"),"true");
    assert.equal(await page.locator("button.tool-move-access").count(),0);
    const canvas=await page.locator("#model-canvas").boundingBox();await page.mouse.click(canvas.x+canvas.width*0.48,canvas.y+canvas.height*0.55);await idle();
    assert.equal(await page.locator("#sketch-pivot").getAttribute("aria-pressed"),"false");assert.equal(await page.locator("button.tool-move-access").count(),4);
    const pivot=await snapshot();await control("sketch-move-x").click();await x.fill("3 mm");await idle();await x.press("Enter");await idle();
    await page.locator("#sketch-copy").check();await idle();const copiesBefore=(await snapshot()).entities.length;await page.locator("#sketch-action").click();await idle();assert.ok((await snapshot()).entities.length>copiesBefore);
    await select(refs.line.curves,"scale");assert.equal(await page.locator("#sketch-pivot svg").count(),1);assert.equal(await page.locator("#sketch-copy").isVisible(),false);
    await select(refs.line.curves);await page.locator("#sketch-copy").uncheck();await idle();
    await control("sketch-move-y").click();await y.fill("5 mm");await idle();await y.press("Enter");await idle();
    const resumed=await snapshot(),documentId=await page.locator('#document-tabs [aria-selected="true"]').getAttribute("data-document");
    await page.getByText("File",{exact:true}).click();await page.locator("#menu-new").click();await page.waitForFunction(id=>document.querySelector('#document-tabs [aria-selected="true"]').dataset.document!==id,documentId);
    await page.locator(`#document-tabs [data-document="${documentId}"]`).click();await idle();assert.deepEqual((await snapshot()).values,resumed.values);
    await control("sketch-move-y").click();await idle();
    await page.mouse.move(40,100);await page.waitForFunction(()=>document.querySelector("#ui-tooltip").hidden);await page.screenshot({path:"/private/tmp/pamatcad-move-control.png"});
    await page.setViewportSize({width:820,height:700});
    await page.waitForFunction(()=>{const f=document.querySelector('#sketch-move-y').parentElement.getBoundingClientRect(),b=document.querySelector('#model-canvas').getBoundingClientRect();return f.x>=b.x&&f.right<=b.right;});await idle();
    const field=await y.locator("..").boundingBox(),bounds=await page.locator("#model-canvas").boundingBox();assert.ok(field.x>=bounds.x&&field.x+field.width<=bounds.x+bounds.width);
    await page.screenshot({path:"/private/tmp/pamatcad-move-control-narrow.png"});
    assert.notDeepEqual(pivot.origin,[0,0,0]);
    console.log("Move: pivot icon, Copy, Scale parity, document switching and narrow viewport passed");
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await idle();
    await select(refs.line.curves);
    const view=await page.evaluate(()=>window.moveCheck.tool.viewport.captureView());
    const reach=()=>page.evaluate(()=>{const v=window.moveCheck.tool.viewport,h=v.handles.items[0],p=v.camera.position.clone().fromArray(h.origin).project(v.camera),r=document.querySelector('#model-canvas').getBoundingClientRect(),b=document.querySelector('button[data-handle="sketch-move-x"]').getBoundingClientRect();return Math.hypot(b.x+b.width/2-r.x-(p.x+1)*r.width/2,b.y+b.height/2-r.y-(1-p.y)*r.height/2);});
    assert.ok(Math.abs(await reach()-96)<1);
    await page.evaluate(()=>{const v=window.moveCheck.tool.viewport;v.restoreView({...v.captureView(),zoom:2});});await idle();assert.ok(Math.abs(await reach()-96)<1,"Control retains screen size when zooming");
    for(const mode of ["orthographic","perspective"]){
      await select(refs.line.curves);
      await page.evaluate(mode=>window.moveCheck.tool.viewport.restoreView({mode,position:[30,-40,50],target:[0,0,0],up:[0,0,1],span:60,zoom:1}),mode);await idle();
      const camera=await page.evaluate(()=>window.moveCheck.tool.viewport.captureView());
      await drag("sketch-move-xy",25,-18);assert.equal((await snapshot()).error,"");assert.ok((await snapshot()).values.some(v=>v!==0));
      assert.deepEqual(await page.evaluate(()=>window.moveCheck.tool.viewport.captureView()),camera,"Move gestures do not orbit the camera");
    }
    await page.evaluate(view=>window.moveCheck.tool.viewport.restoreView(view),view);await idle();
    await select(refs.line.curves);
    await control("sketch-move-x").hover();await page.waitForFunction(()=>document.querySelector('.ui-tooltip')?.textContent==='Move X');
    await page.locator("#sketch-pivot").hover();await page.waitForFunction(()=>document.querySelector('.ui-tooltip')?.textContent==='Pick pivot');
    await page.evaluate(async()=>{const t=window.moveCheck.tool;t.choose("select");await t.sketch.support.update(t.scene.construction.builtin.planes.yz);await t.reload();t.viewport.alignSketch();});await idle();
    await select(refs.line.curves);await drag("sketch-move-xy",25,-18);assert.equal((await snapshot()).error,"");
    const plane=await page.evaluate(()=>{const t=window.moveCheck.tool;return {frame:t.state.frame,origin:t.viewport.handles.items[0].origin,values:t.moveAccepted.values,pivot:t.pivot};});
    assert.ok(plane.values[0]>0&&plane.values[1]>0);plane.origin.forEach((n,i)=>assert.ok(Math.abs(n-plane.frame.origin[i]-plane.frame.u[i]*(plane.pivot[0]+plane.values[0])-plane.frame.v[i]*(plane.pivot[1]+plane.values[1]))<1e-8));
    console.log("Move: stable zoom size, oblique cameras, YZ sketch plane and tooltips passed");
  } catch(error) {console.error(await snapshot());await page.screenshot({path:"/private/tmp/pamatcad-move-control-failure.png"});throw error;}
  finally {await page.evaluate(()=>{window.moveCheck?.restore?.();window.moveCheck?.tool.escape();delete window.moveCheck;});await page.setViewportSize(originalViewport);}
}

export async function testSketchEditing(page) {
  await page.getByText("File", { exact: true }).click(); await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts"), start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) { window.editCheck = { tool: this }; return start.apply(this,args); };
    try { document.querySelector("#new-sketch").click(); } finally { SketchTool.prototype.start = start; }
  });
  await page.evaluate(() => chooseSketchPlane("XY"));
  const idle = () => page.waitForFunction(() => { const t=window.editCheck.tool; return t.state&&!t.pending&&!t.updateRunning&&!t.previewQueued&&!t.creating&&!t.viewport.renderPending; });
  const screen = xy => page.evaluate(xy => {
    const { viewport:v,state:{frame} }=window.editCheck.tool; v.camera.updateMatrixWorld();
    const p=v.camera.position.clone().fromArray(frame.origin).addScaledVector(v.camera.position.clone().fromArray(frame.u),xy[0]).addScaledVector(v.camera.position.clone().fromArray(frame.v),xy[1]).project(v.camera),r=document.querySelector("#model-canvas").getBoundingClientRect();
    return [r.x+(p.x+1)*r.width/2,r.y+(1-p.y)*r.height/2];
  },xy);
  const select = async (refs,tool) => { await page.evaluate(({refs,tool})=>{const t=window.editCheck.tool;t.choose("select");t.selected.clear();refs.forEach(r=>t.selected.add(r.id));t.choose(tool);}, {refs,tool});await idle(); };
  const state = () => page.evaluate(()=>window.editCheck.tool.state);
  const handle = id => page.evaluate(id=>{
    const t=window.editCheck.tool,v=t.viewport,h=v.handles.items.find(h=>h.id===id);if(!h)throw Error("Missing handle "+id);
    const project=p=>{const q=v.camera.position.clone().fromArray(p).project(v.camera),r=document.querySelector("#model-canvas").getBoundingClientRect();return [r.x+(q.x+1)*r.width/2,r.y+(1-q.y)*r.height/2];};
    const tip=h.origin.map((x,i)=>x+h.direction[i]*h.value*(h.factor??1)),a=project(tip),b=project(tip.map((x,i)=>x+h.direction[i]));const n=Math.hypot(b[0]-a[0],b[1]-a[1]);return {a,axis:[(b[0]-a[0])/n,(b[1]-a[1])/n]};
  },id);
  const error = async () => assert.equal(await page.locator("#sketch-error").textContent(),"");
  try {
    await idle();
    const refs=await page.evaluate(async()=>{
      const t=window.editCheck.tool,s=t.sketch;
      const a=await s.primitives.add("line",{from:[-30,20],to:[-20,20]}),b=await s.primitives.add("line",{from:[-30,10],to:[-22,10]}),c=await s.primitives.add("line",{from:[-30,0],to:[-23,0]});
      await s.constraints.add("fix",{curves:b.curves});
      const driving=await s.dimensions.add("length",{line:a.curves[0],value:10,mode:"driving",annotation:{position:[-25,24]}}),driven=await s.dimensions.add("length",{line:b.curves[0],mode:"driven",annotation:{position:[-25,14]}}),target=await s.dimensions.add("length",{line:c.curves[0],value:7,mode:"driving",annotation:{position:[-25,4]}});
      const circle=await s.primitives.add("circle",{center:[5,10],diameter:12});
      const left=await s.primitives.add("line",{from:[0,-20],to:[20,-20]}),right=await s.primitives.add("line",{from:[20,-20],to:[20,-4]});
      const cross=await s.primitives.add("line",{from:[-20,-26],to:[10,-26]}),cut1=await s.primitives.add("line",{from:[-10,-28],to:[-10,-24]}),cut2=await s.primitives.add("line",{from:[0,-28],to:[0,-24]});
      await t.reload();return {driving,driven,target,circle,left,right,cross,cut1,cut2};
    });
    await page.mouse.dblclick(...await screen([-25,4]));
    const formula=page.getByRole("textbox",{name:"Dimension formula",exact:true});await formula.fill("100 + 0");
    await formula.evaluate(el=>el.setSelectionRange(6,7)); await page.mouse.click(...await screen([-25,14]));
    assert.match(await formula.inputValue(),/^100 \+ sketches\[.+\]dimension\[.+\]$/); assert.equal(await formula.evaluate(el=>document.activeElement===el),true);
    await formula.fill(`sketches[${(await state()).sketch.id}]dimension[${refs.driven.id}] / 2`); await formula.press("Enter");await idle();await error();
    assert.ok(Math.abs((await state()).dimensions.find(d=>d.id===refs.target.id).computed.value-4)<1e-6);
    await page.mouse.dblclick(...await screen([-25,4]));await formula.fill("");await page.mouse.click(...await screen([-25,24]));assert.match(await formula.inputValue(),new RegExp(refs.driving.id));await formula.press("Escape");await idle();
    console.log("Formula clicks: driving/driven references, caret replacement, focus, evaluation and cancellation passed");

    await select(refs.circle.curves,"offset");
    assert.equal(await page.locator(".sketch-variants svg").count(),3);assert.equal(await page.locator("#sketch-action").isVisible(),false);
    await page.getByRole("button",{name:"Independent",exact:true}).click();await idle();assert.equal(await page.locator("#sketch-offset2").isVisible(),true);
    await page.locator(".sketch-variants").getByRole("button",{name:"Symmetric",exact:true}).click();await idle();assert.equal(await page.locator("#sketch-offset2").isVisible(),false);
    await page.getByRole("button",{name:"One sided",exact:true}).click();await idle();
    const offset=page.getByRole("textbox",{name:"Offset distance",exact:true});await offset.fill("");await page.mouse.click(...await screen([-25,24]));assert.match(await offset.inputValue(),new RegExp(refs.driving.id));
    await offset.press("End");await offset.pressSequentially(" / 5");await idle();await error();
    await page.screenshot({path:"/private/tmp/pamatcad-offset-interactive.png"});
    await offset.press("Enter");await idle();await error();assert.equal((await state()).entities.filter(e=>e.geometry.type==="circle").length,2);
    const linked=(await state()).offsets[0], linkedCurve=(await state()).entities.find(e=>linked.sides[0].some(r=>r.id===e.reference.id)&&e.geometry.type==="circle").reference;
    await page.keyboard.press("Escape");await idle();
    await page.mouse.dblclick(...await screen([5,2]));await offset.waitFor({state:"visible"});await idle();
    assert.equal(await page.evaluate(()=>window.editCheck.tool.editingOffset),linked.id);assert.match(await offset.inputValue(),/\/ 5/);
    await offset.fill("3 mm");await idle();await offset.press("Escape");await idle();assert.deepEqual((await state()).offsets[0],linked);
    const savedLabel=await page.evaluate(id=>{const t=window.editCheck.tool,o=t.state.offsets.find(o=>o.id===id),a=t.offsetAnchor(t.state,o.sources),d=o.distance1.computed.value;return [a.origin[0]+a.direction[0]*d/2-a.direction[1]*t.viewport.pixelLength*18,a.origin[1]+a.direction[1]*d/2+a.direction[0]*t.viewport.pixelLength*18];},linked.id);
    await page.mouse.dblclick(...await screen(savedLabel));await offset.waitFor({state:"visible"});await idle();
    assert.equal(await page.evaluate(()=>window.editCheck.tool.editingOffset),linked.id);
    await offset.fill("3 mm");await idle();await offset.press("Enter");await idle();await error();
    assert.deepEqual((await state()).offsets[0].sides,linked.sides);assert.equal((await state()).entities.find(e=>e.reference.id===linkedCurve.id).geometry.radius,9);
    await page.evaluate(async id=>{const t=window.editCheck.tool;await t.sketch.dimensions.update(id,{value:12});await t.reload();},refs.driving.id);await idle();
    await page.mouse.dblclick(...await screen([5,1]));await offset.waitFor({state:"visible"});await idle();
    assert.equal(await page.evaluate(()=>window.editCheck.tool.editingOffset),linked.id);
    await offset.fill(`sketches[${(await state()).sketch.id}]dimension[${refs.driving.id}] / 5`);await idle();await offset.press("Enter");await idle();await error();
    assert.ok(Math.abs((await state()).entities.find(e=>e.reference.id===linkedCurve.id).geometry.radius-8.4)<1e-6);
    await page.evaluate(async id=>{const t=window.editCheck.tool;await t.sketch.dimensions.update(id,{value:13});await t.reload();},refs.driving.id);await idle();
    assert.ok(Math.abs((await state()).entities.find(e=>e.reference.id===linkedCurve.id).geometry.radius-8.6)<1e-6);
    await page.evaluate(async id=>{const t=window.editCheck.tool;await t.sketch.dimensions.update(id,{value:12});await t.reload();},refs.driving.id);await idle();
    console.log("Linked Offset: curve/distance reopening, saved formulas, source updates, stable IDs and cancellation passed");
    await select(refs.circle.curves,"offset");const original=await state();await offset.fill("4 mm");await idle();await offset.press("Escape");await idle();assert.deepEqual((await state()).entities,original.entities);
    await select(refs.circle.curves,"offset");const drag=await handle("sketch-offset");
    assert.equal(await page.evaluate(()=>{const h=window.editCheck.tool.viewport.handles,g=h.group.children.find(g=>g.userData.handle.id==="sketch-offset");return h.items.every(h=>h.style==="thin")&&g.children[0].material.opacity===0&&g.children[1].material.opacity===1;}),true);
    // Start off the visible thin shaft, inside its invisible pick target.
    drag.a=[drag.a[0]+drag.axis[0]*10-drag.axis[1]*3,drag.a[1]+drag.axis[1]*10+drag.axis[0]*3];
    await page.mouse.move(...drag.a);await page.mouse.down();assert.equal(await page.evaluate(()=>!!window.editCheck.tool.viewport.handles.drag),true);await page.mouse.move(drag.a[0]+drag.axis[0]*35,drag.a[1]+drag.axis[1]*35,{steps:5});await page.mouse.up();await idle();await error();assert.equal((await state()).entities.filter(e=>e.geometry.type==="circle").length,3);
    await select([refs.target.parameters.line],"offset");await offset.fill("2 mm");await idle();await error();
    const lineHandle=await handle("sketch-offset");await page.mouse.move(...lineHandle.a);await page.mouse.down();await page.mouse.move(lineHandle.a[0]+lineHandle.axis[0]*18,lineHandle.a[1]+lineHandle.axis[1]*18,{steps:3});const lineDistance=parseFloat(await offset.inputValue());await page.mouse.up();await idle();await error();
    assert.ok((await state()).entities.some(e=>e.geometry.type==="point"&&Math.abs(e.geometry.position[1]-lineDistance)<1e-6));
    console.log("Offset: icon modes, inline reference formula, circle/open-line live release and Escape passed");

    await select([...refs.left.curves,...refs.right.curves],"rounding");assert.equal(await page.locator("#sketch-tool-title").textContent(),"Fillet");assert.equal(await page.locator("#sketch-action").isVisible(),false);
    const radius=page.getByRole("textbox",{name:"Radius",exact:true});await radius.fill("2 mm");await idle();await error();await radius.press("Enter");await idle();await error();
    let fillet=(await state()).dimensions.find(d=>d.kind==="radius");assert.ok(fillet);
    const radiusLabel=await page.evaluate(id=>{const t=window.editCheck.tool;return import("/src/sketch-dimensions.ts").then(m=>m.dimensionLayout(t.state,t.state.dimensions.find(d=>d.id===id)).label);},fillet.id);
    await page.mouse.dblclick(...await screen(radiusLabel));await radius.waitFor({state:"visible"});await radius.fill("3 mm");await idle();await radius.press("Enter");await idle();await error();assert.ok(Math.abs((await state()).dimensions.find(d=>d.id===fillet.id).computed.value-3)<1e-6);
    const currentLabel=await page.evaluate(id=>{const t=window.editCheck.tool;return import("/src/sketch-dimensions.ts").then(m=>m.dimensionLayout(t.state,t.state.dimensions.find(d=>d.id===id)).label);},fillet.id);
    await page.mouse.dblclick(...await screen(currentLabel));await radius.waitFor({state:"visible"});await idle();
    const radiusDrag=await handle("sketch-radius");await page.mouse.move(...radiusDrag.a);await page.mouse.down();await page.mouse.move(radiusDrag.a[0]-radiusDrag.axis[0]*16,radiusDrag.a[1]-radiusDrag.axis[1]*16,{steps:4});const draggedRadius=parseFloat(await radius.inputValue());assert.ok(draggedRadius>3,"Dragging inward increases fillet radius");await page.mouse.up();await idle();await error();assert.ok(Math.abs((await state()).dimensions.find(d=>d.id===fillet.id).computed.value-draggedRadius)<1e-5);
    const enlargedLabel=await page.evaluate(id=>{const t=window.editCheck.tool;return import("/src/sketch-dimensions.ts").then(m=>m.dimensionLayout(t.state,t.state.dimensions.find(d=>d.id===id)).label);},fillet.id);
    await page.mouse.dblclick(...await screen(enlargedLabel));await radius.waitFor({state:"visible"});await idle();
    const smaller=await handle("sketch-radius");await page.mouse.move(...smaller.a);await page.mouse.down();await page.mouse.move(smaller.a[0]+smaller.axis[0]*8,smaller.a[1]+smaller.axis[1]*8,{steps:3});const smallerRadius=parseFloat(await radius.inputValue());assert.ok(smallerRadius<draggedRadius,"Dragging outward decreases fillet radius");await page.mouse.up();await idle();await error();
    await page.evaluate(async()=>{
      const t=window.editCheck.tool,s=t.sketch,line=await s.primitives.add("line",{from:[70,0],to:[90,0]}),spline=await s.primitives.add("spline",{points:[[90,0],[90,7],[94,14],[95,20]],fit:false});
      await s.modifyCurves([spline.curves[0]],{type:"offset",distance1:2},{preview:true});
      const offsetState=await s.state({preview:true}),offsetProxy=await s.getProxy({preview:true}),offset=offsetState.offsets.find(o=>!t.state.offsets.some(old=>old.id===o.id));
      const anchor=t.offsetAnchor(offsetState,offset.sources,offset,offsetProxy),sample=offsetProxy.curves.filter(c=>offset.sides[0].some(r=>r.id===c.entity.id)).flatMap(c=>c.points).sort((a,b)=>Math.hypot(a[0]-anchor.origin[0],a[1]-anchor.origin[1])-Math.hypot(b[0]-anchor.origin[0],b[1]-anchor.origin[1]))[0];
      if((sample[0]-anchor.origin[0])*anchor.direction[0]+(sample[1]-anchor.origin[1])*anchor.direction[1]<=0)throw Error("Offset spline handle points away from the generated side");
      await t.scene.discardPreview();
      await s.modifyCurves([line.curves[0],spline.curves[0]],{type:"fillet",radius:2},{preview:true});
      const state=await s.state({preview:true}),proxy=await s.getProxy({preview:true}),{constraintBuckets}=await import("/src/sketch-constraint-layout.ts");
      const buckets=constraintBuckets(state,proxy),tangencies=state.constraints.filter(c=>c.kind==="tangent");
      if(!tangencies.every(c=>buckets.some(b=>b.constraints.some(marker=>marker.id===c.id))))throw Error("Missing fillet tangent marker");
      await t.scene.discardPreview();await s.remove([line.id,spline.id]);await t.reload();
    });await idle();
    console.log("Fillet: creation, persistent radius, double-click editing, repeat dragging and spline tangent markers passed");

    await page.locator('[data-tool="split"]').click();await page.mouse.move(...await screen([-10,-26]));await page.waitForFunction(()=>!!window.editCheck.tool.splitTarget);
    assert.equal(await page.locator("#sketch-action").isVisible(),false);await page.mouse.click(...await screen([-10,-26]));await idle();await error();
    assert.ok(!(await state()).entities.some(e=>e.reference.id===refs.cross.id));assert.ok((await state()).entities.some(e=>e.reference.id===refs.cut2.id));
    console.log("Split: intersection hover, local click and unaffected crossing passed");

    await page.evaluate(()=>{window.editCheck.tool.input("sketch-copy").checked=true;});
    await select(refs.circle.curves,"scale");assert.equal(await page.locator("#sketch-copy").isVisible(),false);const count=(await state()).entities.length;
    const scale=page.getByRole("textbox",{name:"Scale factor",exact:true});await scale.fill("3 / 2");await idle();await scale.press("Enter");await idle();await error();assert.equal((await state()).entities.length,count);assert.ok(Math.abs((await state()).entities.find(e=>e.reference.id===refs.circle.id).geometry.radius-9)<1e-6);
    await select(refs.circle.curves,"scale");
    await page.evaluate(()=>{const t=window.editCheck.tool,transform=t.sketch.transform.bind(t.sketch);window.editCheck.calls=[];t.sketch.transform=async options=>{window.editCheck.calls.push(options);const result=await transform(options);if(options.preview&&window.editCheck.hold){window.editCheck.hold=false;await new Promise(resolve=>window.editCheck.release=resolve);}return result;};window.editCheck.hold=true;});
    const h=await handle("sketch-scale");await page.mouse.move(...h.a);await page.mouse.down();await page.mouse.move(h.a[0]+h.axis[0]*20,h.a[1]+h.axis[1]*20);await page.waitForFunction(()=>!!window.editCheck.release);
    await page.mouse.move(h.a[0]+h.axis[0]*45,h.a[1]+h.axis[1]*45);const factor=Number(await scale.inputValue());await page.mouse.up();await page.evaluate(()=>window.editCheck.release());await idle();await error();
    assert.ok(Math.abs((await state()).entities.find(e=>e.reference.id===refs.circle.id).geometry.radius-9*factor)<1e-5);assert.equal((await state()).entities.length,count);
    const calls=await page.evaluate(()=>window.editCheck.calls);assert.equal(calls.filter(c=>!c.preview).length,1);assert.ok(calls.every(c=>c.copy===false));
    assert.ok(Math.abs((await state()).entities.find(e=>e.reference.id===linkedCurve.id).geometry.radius-(9*factor+2.4))<1e-5,"Source scale updates its linked offset");
    await select(refs.circle.curves,"move");assert.equal(await page.evaluate(()=>window.editCheck.tool.viewport.handles.items.every(h=>h.style==="move")),true);
    await page.screenshot({path:"/private/tmp/pamatcad-tools-interactive.png"});
    console.log("Scale: formula, no copy and delayed live drag/final release passed");
  } catch (error) { console.error(await page.evaluate(()=>({tool:window.editCheck.tool.tool,selected:[...window.editCheck.tool.selected],error:document.querySelector("#sketch-error").textContent,fillet:window.editCheck.tool.filletDimension,pending:window.editCheck.tool.pending,inputs:[...document.querySelectorAll(".sketch-live-dimensions input")].map(el=>[el.id,el.hidden,el.value,el.getClientRects().length])})));await page.screenshot({path:"/private/tmp/pamatcad-tools-failure.png"});throw error; } finally { await page.evaluate(()=>{window.editCheck?.tool.escape();delete window.editCheck;}); }
}

export async function testOffsetPlacementAndFilletDefaults(page) {
  const viewport=page.viewportSize();await page.setViewportSize({width:1440,height:1000});
  await page.getByText("File",{exact:true}).click();await page.locator("#menu-new").click();
  await page.waitForFunction(()=>!document.querySelector("#new-sketch").disabled);
  await page.evaluate(async()=>{
    const {SketchTool}=await import("/src/tools/sketch.ts"),start=SketchTool.prototype.start;
    SketchTool.prototype.start=function(...args){window.placementCheck={tool:this};return start.apply(this,args);};
    try{document.querySelector("#new-sketch").click();}finally{SketchTool.prototype.start=start;}
  });
  await page.evaluate(()=>chooseSketchPlane("XY"));
  const idle=()=>page.waitForFunction(()=>{const t=window.placementCheck.tool;return t.state&&!t.pending&&!t.creating&&!t.updateRunning&&!t.previewQueued&&!t.viewport.renderPending;});
  const state=()=>page.evaluate(()=>window.placementCheck.tool.state);
  const screen=xy=>page.evaluate(xy=>{
    const t=window.placementCheck.tool,v=t.viewport,f=t.state.frame;v.camera.updateMatrixWorld();
    const p=v.camera.position.clone().fromArray(f.origin).addScaledVector(v.camera.position.clone().fromArray(f.u),xy[0]).addScaledVector(v.camera.position.clone().fromArray(f.v),xy[1]).project(v.camera),r=document.querySelector("#model-canvas").getBoundingClientRect();
    return [r.x+(p.x+1)*r.width/2,r.y+(1-p.y)*r.height/2];
  },xy);
  const select=async(refs,tool)=>{await page.evaluate(({refs,tool})=>{const t=window.placementCheck.tool;t.choose("select");t.selected.clear();refs.forEach(r=>t.selected.add(r.id));t.choose(tool);},{refs,tool});await idle();};
  const drag=async(a,b)=>{await page.mouse.move(...a);await page.mouse.down();await page.mouse.move(...b,{steps:8});await page.mouse.up();await idle();};
  const shown=()=>page.evaluate(()=>window.placementCheck.tool.shownOffsetAnnotations);
  const arrow=()=>page.evaluate(()=>{
    const t=window.placementCheck.tool,h=t.viewport.handles.items.find(h=>h.id==="sketch-offset"),f=t.state.frame;
    const tip=h.origin.map((v,i)=>v+h.direction[i]*h.value);
    return [f.u.reduce((s,v,i)=>s+v*(tip[i]-f.origin[i]),0),f.v.reduce((s,v,i)=>s+v*(tip[i]-f.origin[i]),0)];
  });
  try{
    await idle();
    const refs=await page.evaluate(async()=>{
      const t=window.placementCheck.tool,s=t.sketch,circle=await s.primitives.add("circle",{center:[-15,5],diameter:12});
      await s.modifyCurves(circle.curves,{type:"offset",distance1:2});await s.modifyCurves(circle.curves,{type:"offset",distance1:4});
      const a=await s.primitives.add("line",{from:[0,-15],to:[30,-15]}),b=await s.primitives.add("line",{from:[30,-15],to:[30,65]});
      const c=await s.primitives.add("line",{from:[-25,-20],to:[-15,-20]}),d=await s.primitives.add("line",{from:[-15,-20],to:[-15,0]});
      await t.reload();return{circle,a,b,c,d};
    });
    const original=await state(),labels=await shown(),start=await screen(labels.at(-1).label);
    const picked=await page.evaluate(([x,y])=>window.placementCheck.tool.viewport.sketchPicks({clientX:x,clientY:y})[0],start);
    assert.equal(picked.kind,"dimension");const first=labels.find(a=>a.id===picked.id);
    await drag(start,await screen([-15,18]));
    let moved=await state();assert.deepEqual(moved.entities,original.entities);assert.deepEqual(moved.status,original.status);assert.equal(moved.revision,original.revision);
    const position=moved.offsets.find(o=>o.id===first.offset).annotations[0].position;assert.ok(Math.hypot(position[0]-(-15+first.label[0]-labels.at(-1).label[0]),position[1]-(18+first.label[1]-labels.at(-1).label[1]))<0.15);
    const remaining=(await shown()).find(a=>a.id!==first.id);await drag(await screen(remaining.label),await screen([-28,5]));
    moved=await state();assert.ok(moved.offsets.every(o=>o.annotations[0]));assert.deepEqual(moved.entities,original.entities);
    const beforeCancel=await state(),at=await screen(position);await page.mouse.move(...at);await page.mouse.down();await page.mouse.move(at[0]+35,at[1]-20,{steps:4});await page.keyboard.press("Escape");await page.mouse.up();await idle();
    assert.deepEqual((await state()).offsets,beforeCancel.offsets);
    await page.evaluate(()=>{const t=window.placementCheck.tool;t.viewport.camera.zoom*=1.2;t.viewport.camera.updateProjectionMatrix();t.viewport.render();t.display();});await idle();
    assert.deepEqual((await state()).offsets,beforeCancel.offsets);
    console.log("Offset placement: overlapping labels separate, geometry stays unchanged, Escape and zoom preserve saved positions");

    await select(refs.circle.curves,"offset");const field=page.getByRole("textbox",{name:"Offset distance",exact:true});
    await field.fill("0 mm");await idle();assert.match(await page.locator("#sketch-error").textContent(),/nonzero/);
    assert.equal(await page.evaluate(()=>window.placementCheck.tool.viewport.handles.items.every(h=>[...h.origin,...h.direction,h.value].every(Number.isFinite))),true);
    await field.fill("12 mm");await idle();assert.equal(await page.locator("#sketch-error").textContent(),"");
    const beforeDraft=await state(),tip=await screen(await arrow());
    await page.keyboard.down("Alt");await page.mouse.move(...tip);await page.mouse.down();
    assert.equal(await page.evaluate(()=>window.placementCheck.tool.viewport.handles.drag?.reposition),true);
    await page.mouse.move(tip[0]-35,tip[1]-45,{steps:8});await page.mouse.up();await page.keyboard.up("Alt");await idle();
    assert.deepEqual((await state()).entities,beforeDraft.entities);assert.equal((await state()).offsets.length,2);assert.equal(parseFloat(await field.inputValue()),12);
    const placed=await page.evaluate(()=>window.placementCheck.tool.offsetPositions[0]);assert.ok(placed);
    const annotation=(await shown()).find(a=>a.draft),onLine=annotation.from.map((v,i)=>v+(annotation.to[i]-v)*0.65);
    assert.deepEqual(await page.evaluate(([x,y])=>window.placementCheck.tool.viewport.sketchPicks({clientX:x,clientY:y})[0],await screen(onLine)),{kind:"dimension",id:annotation.id});
    await drag(await screen(onLine),await screen([onLine[0]-2,onLine[1]+3]));
    const finalPosition=await page.evaluate(()=>window.placementCheck.tool.offsetPositions[0]);assert.notDeepEqual(finalPosition,placed);assert.equal(parseFloat(await field.inputValue()),12);
    assert.deepEqual((await state()).entities,beforeDraft.entities);
    const current=await page.locator('#document-tabs [aria-selected="true"]').getAttribute("data-document");
    await page.getByText("File",{exact:true}).click();await page.locator("#menu-new").click();
    await page.waitForFunction(id=>document.querySelector('#document-tabs [aria-selected="true"]').dataset.document!==id,current);
    await page.locator(`#document-tabs [data-document="${current}"]`).click();await idle();
    assert.deepEqual(await page.evaluate(()=>window.placementCheck.tool.offsetPositions[0]),finalPosition);assert.equal(parseFloat(await field.inputValue()),12);
    assert.deepEqual((await state()).offsets,beforeDraft.offsets);
    await field.press("Enter");await idle();assert.equal(await page.locator("#sketch-error").textContent(),"");
    const created=(await state()).offsets.find(o=>!beforeDraft.offsets.some(old=>old.id===o.id));assert.deepEqual(created.annotations[0].position,finalPosition);
    await page.keyboard.press("Escape");await idle();await page.mouse.dblclick(...await screen(finalPosition));await field.waitFor({state:"visible"});await idle();
    assert.deepEqual(await page.evaluate(()=>window.placementCheck.tool.offsetPositions[0]),finalPosition);
    const saved=await state(),cancelTip=await screen(await arrow());await page.keyboard.down("Alt");await page.mouse.move(...cancelTip);await page.mouse.down();await page.mouse.move(cancelTip[0]+25,cancelTip[1]-25,{steps:4});
    await page.evaluate(()=>{const t=window.placementCheck.tool,pointerId=t.viewport.handles.drag.pointer;document.querySelector("#model-canvas").dispatchEvent(new PointerEvent("pointercancel",{pointerId,button:0,bubbles:true}));});
    await page.mouse.up();await page.keyboard.up("Alt");await idle();assert.deepEqual(await page.evaluate(()=>window.placementCheck.tool.offsetPositions[0]),finalPosition);assert.deepEqual((await state()).entities,saved.entities);
    await page.keyboard.press("Escape");await idle();
    await page.screenshot({path:"/private/tmp/pamatcad-offset-placement.png"});
    console.log("Offset creation: Alt-arrow and dimension-line placement keep distance, survive document switching, commit, reopen and cancel correctly");

    await select([...refs.a.curves,...refs.b.curves],"rounding");const radius=page.getByRole("textbox",{name:"Radius",exact:true});assert.equal(parseFloat(await radius.inputValue()),2.5);
    await page.evaluate(()=>{const t=window.placementCheck.tool;t.viewport.camera.zoom*=1.5;t.viewport.camera.updateProjectionMatrix();t.viewport.render();});
    await select([...refs.a.curves,...refs.b.curves],"rounding");assert.equal(parseFloat(await radius.inputValue()),2.5);
    await select([],"rounding");await page.evaluate(ref=>window.placementCheck.tool.pick({kind:"geometry",id:ref.id},true),refs.d.curves[0]);await idle();assert.equal(parseFloat(await radius.inputValue()),2);
    await page.evaluate(ref=>window.placementCheck.tool.pick({kind:"geometry",id:ref.id},true),refs.c.curves[0]);await idle();assert.equal(parseFloat(await radius.inputValue()),1);
    await radius.fill("1.75 mm");await idle();await page.evaluate(ref=>{const t=window.placementCheck.tool;t.pick({kind:"geometry",id:ref.id},true);t.pick({kind:"geometry",id:ref.id},true);},refs.c.curves[0]);await idle();assert.equal(parseFloat(await radius.inputValue()),1.75);
    const rounding=await page.evaluate(async()=>{
      const {niceValue,lengthStep,unitScale}=await import("/src/formula-input.ts"),t=window.placementCheck.tool,s=t.sketch;
      t.choose("select");const arc=await s.primitives.add("arc",{center:[80,0],radius:20,start:0,end:90});await t.reload();t.selected.clear();t.selected.add(arc.curves[0].id);t.choose("rounding");
      return{arc:parseFloat(t.input("sketch-radius").value),defaults:["mm","cm","in"].map(unit=>niceValue(30/10/unitScale[unit])),steps:[lengthStep(0.1,800,"mm",30),lengthStep(0.001,800,"mm",0.3),lengthStep(25.4/128,800,"in",25.4)]};
    });
    assert.equal(rounding.arc,2.5);assert.deepEqual(rounding.defaults,[2.5,0.25,0.1]);assert.deepEqual(rounding.steps,[2,0.02,25.4/8]);
    console.log("Fillet defaults: shorter line / 10, shared nice values, curve fallback, zoom, tool-first selection and typed radius preservation passed");
  }catch(error){console.error(await page.evaluate(()=>{const t=window.placementCheck.tool;return{tool:t.tool,error:t.get("sketch-error").textContent,drag:t.annotationDrag,placements:t.offsetPositions,annotations:t.shownOffsetAnnotations,selected:[...t.selected]};}));await page.screenshot({path:"/private/tmp/pamatcad-placement-failure.png"});throw error;}
  finally{await page.keyboard.press("Escape");await page.evaluate(()=>delete window.placementCheck);if(viewport)await page.setViewportSize(viewport);}
}
