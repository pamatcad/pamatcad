import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core, WebSocketTransport, type Method, type Parameters } from "@pamatcad/sdk";
import { startCore } from "../../support/core.js";
import { near, rectangle } from "../../support/extrude.js";

test("circular projections retain centers, tangent constraints and radius dimensions through source edits", async t => {
  const {core,scene}=await startCore(t,"project-circle");
  const source=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle=await source.primitives.add("circle",{center:[7,4],diameter:20});
  const diameter=await source.dimensions.add("diameter",{curve:circle.curves[0]!,value:20,mode:"driving"});
  await source.complete();const profile=await source.regions.only();
  const solid=await core.solid.extrude(profile,{length1:8});
  const face=await solid.faces.endCap1({profile}).only();
  const sketch=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const projection=await sketch.projections.add({type:"face",reference:face});
  let state=await sketch.state();
  assert.equal(projection.entities.length,2);
  const projected=state.entities.find(e=>e.projected&&e.geometry.type==="circle")!;
  assert.ok(projected);assert.equal(projected.geometry.type,"circle");
  if(projected.geometry.type!=="circle")throw Error("Expected a projected circle");
  const centerId=projected.geometry.center,center=state.entities.find(e=>e.reference.id===centerId)!;
  assert.deepEqual(center.geometry,{type:"point",position:[7,4]});assert.ok(center.projected);
  near(projected.geometry.radius,10);
  const line=await sketch.primitives.add("line",{from:[-12,14],to:[26,14],construction:true});
  await sketch.constraints.add("horizontal",{curves:line.curves});
  const tangent=await sketch.constraints.add("tangent",{curves:[line.curves[0]!,projected.reference]});
  const radius=await sketch.dimensions.add("radius",{curve:projected.reference,mode:"driven"});
  await sketch.dimensions.add("diameter",{curve:projected.reference,mode:"driven"});
  const before=await sketch.state();
  await assert.rejects(sketch.drag(center.reference,[0,0]),/read-only/);
  await assert.rejects(sketch.drag(projected.reference,{position:[30,4]}),/read-only/);
  assert.deepEqual(await sketch.state(),before);
  await sketch.complete();
  const output=await core.solid.extrude(await sketch.regions.only(),{length1:3,mode:"newBody"});
  near((await (await scene.bodies.get(output.newSolids[0]!.id)).properties()).volume.value,Math.PI*100*3);
  await source.edit();await source.dimensions.update(diameter.id,{value:24});await source.complete();
  state=await sketch.state();assert.equal(state.projections[0]!.warning,null);
  assert.deepEqual(state.projections[0]!.entities,projection.entities);
  assert.ok(state.constraints.some(c=>c.id===tangent.id));
  near(state.dimensions.find(d=>d.id===radius.id)!.computed.value,12);
  const updated=state.entities.find(e=>e.reference.id===projected.reference.id)!;
  assert.equal(updated.geometry.type,"circle");
  if(updated.geometry.type==="circle"){assert.equal(updated.geometry.center,center.reference.id);near(updated.geometry.radius,12);}
  near((await (await scene.bodies.get(output.newSolids[0]!.id)).properties()).volume.value,Math.PI*144*3);
  await sketch.edit();
  for(let i=0;i<2;i++){
    await sketch.projections.update(projection.id,{type:"face",reference:face});await sketch.recompute();
    const current=await sketch.state();assert.deepEqual(current.entities,state.entities);assert.deepEqual(current.projections[0]!.entities,projection.entities);
  }
  await sketch.complete();
  const supported=await scene.sketches.create(face);
  await supported.projections.add({type:"face",reference:face});
  assert.equal((await supported.state()).entities.filter(e=>e.projected&&e.geometry.type==="circle").length,1);
  await supported.cancel();
});

test("projected slot boundaries retain exact arcs and remap centers and endpoints on refresh", async t=>{
  const {core,scene}=await startCore(t,"project-slot-arcs");
  const source=await scene.sketches.create(scene.construction.builtin.planes.yz);
  await source.primitives.add("slot",{from:[0,0],to:[20,0],radius:5});
  await source.complete();const profile=await source.regions.only(),solid=await core.solid.extrude(profile,{length1:8});
  const face=await solid.faces.endCap1({profile}).only(),sketch=await scene.sketches.create(scene.construction.builtin.planes.yz);
  const projection=await sketch.projections.add({type:"face",reference:face});
  const state=await sketch.state(),arcs=state.entities.filter(e=>e.geometry.type==="arc");
  assert.equal(arcs.length,2);assert.equal(state.entities.filter(e=>e.geometry.type==="line").length,2);
  assert.equal(state.entities.filter(e=>e.geometry.type==="spline").length,0);
  for(const arc of arcs){
    assert.equal(arc.geometry.type,"arc");if(arc.geometry.type!=="arc")continue;
    const g=arc.geometry;near(g.radius,5);near(Math.abs(g.end-g.start),Math.PI);
    for(const id of [g.center,g.from,g.to])assert.ok(state.entities.some(e=>e.reference.id===id&&e.geometry.type==="point"&&e.projected));
  }
  for(let i=0;i<3;i++){
    await sketch.projections.update(projection.id,{type:"face",reference:face});await sketch.recompute();
    assert.deepEqual((await sketch.state()).entities,state.entities);
    assert.deepEqual((await sketch.state()).projections[0]!.entities,projection.entities);
  }
  await sketch.complete();await sketch.edit();assert.deepEqual((await sketch.state()).entities,state.entities);await sketch.complete();
  const result=await core.solid.extrude(await sketch.regions.only(),{length1:2,mode:"newBody"});
  near((await (await scene.bodies.get(result.newSolids[0]!.id)).properties()).volume.value,(200+25*Math.PI)*2);
  const other=await scene.sketches.create(scene.construction.builtin.planes.xy);
  await other.primitives.add("circle",{center:[0,0],diameter:10});await other.complete();
  const otherProfile=await other.regions.only(),cylinder=await core.solid.extrude(otherProfile,{length1:2});
  await sketch.edit();const before=await sketch.state();
  await assert.rejects(sketch.projections.update(projection.id,{type:"face",reference:await cylinder.faces.endCap1({profile:otherProfile}).only()}),/topology|geometry type/);
  assert.deepEqual(await sketch.state(),before);
});

test("project circular edges analytically and retain exact oblique projections as rational splines",async t=>{
  const {core,scene}=await startCore(t,"project-oblique");
  const source=await scene.sketches.create(scene.construction.builtin.planes.xy);
  await source.primitives.add("circle",{center:[0,0],diameter:10});await source.complete();
  const profile=await source.regions.only(),cylinder=await core.solid.extrude(profile,{length1:2});
  const proxy=await scene.getProxyFor(cylinder.newSolids[0]!),edge=proxy.edges.find(e=>e.closed)!;
  assert.ok(edge);
  const parallel=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const projection=await parallel.projections.add({type:"edge",reference:edge.edge});
  const parallelState=await parallel.state();assert.equal(projection.entities.length,2);
  assert.equal(parallelState.entities.filter(e=>e.projected&&e.geometry.type==="circle").length,1);
  await parallel.projections.update(projection.id,{type:"edge",reference:edge.edge});assert.deepEqual((await parallel.state()).entities,parallelState.entities);await parallel.complete();
  const support=await scene.sketches.create(scene.construction.builtin.planes.yz);
  const corners:[[number,number],[number,number],[number,number],[number,number]]=[[-20,-20],[20,0],[20,20],[-20,0]];
  for(let i=0;i<4;i++)await support.primitives.add("line",{from:corners[i]!,to:corners[(i+1)%4]!});await support.complete();
  const block=await core.solid.extrude(await support.regions.only(),{length1:5,mode:"newBody"});
  const body=await scene.bodies.get(block.newSolids[0]!.id),face=await body.faces.query({normal:[0,-1/Math.sqrt(5),2/Math.sqrt(5)]}).only();
  const sketch=await scene.sketches.create(face);
  await sketch.projections.add({type:"face",reference:await cylinder.faces.endCap1({profile}).only()});
  const state=await sketch.state(),spline=state.entities.find(e=>e.geometry.type==="spline")!;
  assert.ok(spline);assert.equal(state.entities.filter(e=>e.geometry.type==="circle"||e.geometry.type==="arc").length,0);
  assert.equal(spline.geometry.type,"spline");if(spline.geometry.type==="spline")assert.ok(spline.geometry.closed&&spline.geometry.weights.some(w=>w!==1));
  const normal=state.frame.normal;
  for(const curve of (await sketch.getProxy()).curves)for(const q of curve.points){
    const travel=(2-q[2])/normal[2];near(Math.hypot(q[0]+normal[0]*travel,q[1]+normal[1]*travel),5);
  }
  await sketch.complete();const result=await core.solid.extrude(await sketch.regions.only(),{length1:3,mode:"newBody"});
  // The kernel's non-adaptive mass integration is approximate for rational spline surfaces.
  // Exact curve samples above verify the projection independently of that integration.
  const volume=(await (await scene.bodies.get(result.newSolids[0]!.id)).properties()).volume.value,expected=Math.PI*25*Math.abs(normal[2])*3;
  assert.ok(Math.abs(volume-expected)/expected<0.002);
});

test("analytic projections replay public commands with stable references and exact solids",{skip:process.env.PAMATCAD_TEST_RUNTIME==="wasm"},async t=>{
  const commands:{jsonrpc:"2.0";id:number;method:Method;params:Parameters<Method>}[]=[],responses:unknown[]=[];
  const {url}=await startCore(t,"projection-replay"),transport=await WebSocketTransport.connect(url);t.after(()=>transport.close());
  const core=new Core({async request(method,params){commands.push(JSON.parse(JSON.stringify({jsonrpc:"2.0",id:commands.length+1,method,params})));const result=await transport.request(method,params);responses.push(result);return result;},close(){transport.close();}});
  const scene=await core.scene.create("analytic-projection"),base=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle=await base.primitives.add("circle",{center:[2,3],diameter:8});
  const diameter=await base.dimensions.add("diameter",{curve:circle.curves[0]!,value:8,mode:"driving"});
  await base.complete();const profile=await base.regions.only(),solid=await core.solid.extrude(profile,{length1:5});
  const sketch=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const source={type:"face" as const,reference:await solid.faces.endCap1({profile}).only()},projection=await sketch.projections.add(source);
  await sketch.projections.update(projection.id,source);await sketch.recompute();await sketch.state();await sketch.complete();
  const output=await core.solid.extrude(await sketch.regions.only(),{length1:2,mode:"newBody"});
  await base.edit();await base.dimensions.update(diameter.id,{value:10});await base.complete();await sketch.state();
  near((await (await scene.bodies.get(output.newSolids[0]!.id)).properties()).volume.value,Math.PI*25*2);
  const directory=await mkdtemp(join(tmpdir(),"pamatcad-projection-replay-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,"projection.jsonl");await writeFile(file,commands.map(command=>JSON.stringify(command)).join("\n"));
  const replay=await startCore(t,"projection-replay"),target=await WebSocketTransport.connect(replay.url);t.after(()=>target.close());
  const actual=[];for(const line of (await readFile(file,"utf8")).split("\n")){const command=JSON.parse(line) as typeof commands[number];actual.push(await target.request(command.method,command.params));}
  assert.deepEqual(actual,responses);
});

test("project a solid face into a planar sketch as linked read-only curves", async (t) => {
  const { core, scene } = await startCore(t, "projected-face");
  const base = await rectangle(scene);
  const feature = await core.solid.extrude(base.profile, { length1: 10 });
  const face = await feature.faces.endCap1({ profile: base.profile }).only();
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const projection = await sketch.projections.add({ type: "face", reference: face });
  const state = await sketch.state();
  assert.equal(state.entities.filter(e => e.projected && e.geometry.type === "line").length, 4);
  assert.equal(state.status.degreesOfFreedom, 0);
  const point = state.entities.find(e => e.projected && e.geometry.type === "point")!;
  await assert.rejects(sketch.drag(point.reference, [20, 30]), /read-only/);
  const line = state.entities.find(e => e.projected && e.geometry.type === "line")!;
  await assert.rejects(sketch.drag(line.reference, { from: [20, 30], to: [30, 30] }), /read-only/);
  assert.deepEqual(await sketch.state(), state);
  assert.equal(projection.warning, null);
  await sketch.complete();
  const extruded = await core.solid.extrude(await sketch.regions.only(), { length1: 5 });
  near((await (await scene.bodies.get(extruded.newSolids[0]!.id)).properties()).volume.value, 500);
});
test("text creates closed exact outline curves that can be extruded", async (t) => {
  const { core, scene } = await startCore(t, "text-profile");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const text = await sketch.primitives.add("text", { text: "B", origin: [0, 0], size: "10 mm", weight: 700 });
  assert.ok(text.curves.length > 4);
  await sketch.complete();
  const proxy = await sketch.getProxy();
  const outline = proxy.regions.find(r => r.holes.length === 2);
  assert.ok(outline, JSON.stringify(proxy.regions.map(r => ({ id: r.region.id, holes: r.holes.length, boundary: r.boundary.length }))));
  const feature = await core.solid.extrude(outline.region, { length1: 2 });
  assert.ok((await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value > 0);
});
test("imported text follows an anchored guideline and respects construction mode", async (t) => {
  const { scene } = await startCore(t, "text-guideline");
  const fontBase64 = (await readFile("native/sketch/fonts/Roboto.ttf")).toString("base64");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const guide = await sketch.primitives.add("line", { from: [100, 200], to: [200, 200], construction: true });
  const text = await sketch.primitives.add("text", {
    text: "B", origin: [150, 200], size: "20 mm / 2", fontBase64,
    horizontal: "center", vertical: "top", guide: guide.curves[0], construction: true,
  });
  const proxy = await sketch.getProxy();
  assert.equal(proxy.regions.length, 0);
  const outlinePoints = proxy.curves.filter(c => text.curves.some(r => r.id === c.entity.id)).flatMap(c => c.points);
  assert.ok(outlinePoints.length > 4);
  assert.ok(outlinePoints.every(([x, y]) => x > 140 && x < 160 && y > 180 && y <= 200));
  const before = await sketch.state();
  await assert.rejects(sketch.primitives.add("text", {
    text: "B", origin: [100, 200], size: 10, guide: guide.curves[0], horizontal: "right",
  }), /beyond its guideline/);
  assert.deepEqual(await sketch.state(), before);
  await sketch.construction(text.curves, false);
  await sketch.complete();
  assert.equal((await sketch.regions.all()).length, 3);
  assert.ok((await sketch.getProxy()).regions.some(r => r.holes.length === 2));
});
test("primitive previews expose temporary geometry without changing the working sketch", async (t) => {
  const { scene } = await startCore(t, "sketch-preview");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const before = await sketch.state();
  await sketch.primitives.add("circle", { center: [0, 0], diameter: 10 }, { preview: true });
  assert.equal((await sketch.getProxy({ preview: true })).regions.length, 1);
  assert.deepEqual(await sketch.state(), before);
  await sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
  await assert.rejects(sketch.getProxy({ preview: true }), /cached/);
  await sketch.cancel();
  assert.deepEqual(await scene.timeline.list(), []);
});
test("project exact solid vertices and repair or remove their cached references", async (t) => {
  const { core, scene } = await startCore(t, "project-vertex");
  const base = await rectangle(scene);
  const feature = await core.solid.extrude(base.profile, { length1: 10 });
  const body = await scene.bodies.get(feature.newSolids[0]!.id);
  const vertices = await body.vertices.all();
  assert.equal(vertices.length, 8);
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const source = vertices.find(v => v.position[2] === 10)!;
  const projection = await sketch.projections.add({ type: "vertex", reference: source.vertex });
  const state = await sketch.state();
  const p = state.entities.find(e => e.projected)!;
  assert.equal(p.geometry.type, "point");
  if (p.geometry.type === "point") {
    assert.deepEqual(p.geometry.position, source.position.slice(0, 2));
  }
  await sketch.projections.update(projection.id, { type: "vertex", reference: vertices[0]!.vertex });
  await sketch.remove([projection.id]);
  assert.equal((await sketch.state()).projections.length, 0);
  assert.equal((await sketch.state()).entities.length, 1);
});
test("transform previews replace the temporary sketch and are explicitly discarded", async (t) => {
  const { scene } = await startCore(t, "transform-preview");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [0, 0], diameter: 10 });
  const before = await sketch.state();
  await sketch.transform({ entities: circle.curves, translation: [20, 10], preview: true });
  assert.deepEqual(await sketch.state(), before);
  const proxy = await sketch.getProxy({ preview: true });
  assert.ok(proxy.points.some(p => p.position[0] === 20 && p.position[1] === 10));
  await scene.discardPreview();
  await assert.rejects(sketch.getProxy({ preview: true }), /cached/);
});
test("lost support and projection retain cached geometry during downstream replay", async (t) => {
  const { core, scene } = await startCore(t, "cached-projection");
  const base = await rectangle(scene);
  const block = await core.solid.extrude(base.profile, { length1: 10 });
  const cutter = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const cutRectangle = await cutter.primitives.add("rectangle", { from: [5, 0], to: [15, 10] });
  await cutter.complete();
  await core.solid.extrude(await cutter.regions.only(), { length1: 10, mode: "cut" });
  const face = await block.faces.endCap1({ profile: base.profile }).only();
  const sketch = await scene.sketches.create(face);
  await sketch.projections.add({ type: "face", reference: face });
  await sketch.complete();
  const result = await core.solid.extrude(await sketch.regions.only(), { length1: 2, mode: "newBody" });
  await cutter.edit();
  await cutter.transform({ entities: cutRectangle.curves, translation: [-5, 0] });
  await cutter.complete();
  const state = await sketch.state();
  assert.ok(state.status.warnings.some(w => w.includes("cached plane")));
  assert.ok(state.projections[0]!.warning?.includes("cached projection"));
  const bodies = await scene.bodies.all();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.id, result.newSolids[0]!.id);
  near((await (await scene.bodies.get(bodies[0]!.id)).properties()).volume.value, 100);
});
