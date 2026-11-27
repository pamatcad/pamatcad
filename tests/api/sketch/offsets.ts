import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";
import type { SketchState } from "@pamatcad/sdk";

const point = (state: SketchState, id: string) => {
  const g = state.entities.find(e => e.reference.id === id)!.geometry;
  if (g.type !== "point") assert.fail("Expected point");
  return g.position;
};
const radius = (state: SketchState, id: string) => {
  const g = state.entities.find(e => e.reference.id === id)!.geometry;
  if (g.type !== "circle" && g.type !== "arc") assert.fail("Expected circle or arc");
  return g.radius;
};

test("linked line offset retains formulas and references through source edits, mode edits and deletion", async t => {
  const { scene } = await startCore(t, "linked-offset-line"), s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await s.primitives.add("line", { from: [0,0], to: [20,0] });
  await s.constraints.add("fix", { points: [line.points[0]!] });
  await s.constraints.add("horizontal", { curves: line.curves });
  const length = await s.dimensions.add("length", { line: line.curves[0], value: 20, mode: "driving", name: "span" });
  const edit = await s.modifyCurves(line.curves, { type: "offset", distance1: "span / 10" });
  const definition = (await s.state()).offsets[0]!, generated = edit.created[0]!;
  await s.modifyCurves([], {type:"offsetAnnotation",id:definition.id,side:0,position:[8,6]});
  const measured = await s.dimensions.add("length", { line: generated, mode: "driven" });
  await s.dimensions.update(length.id, { name: "width", value: 30 });
  let state = await s.state(), g = state.entities.find(e => e.reference.id === generated.id)!.geometry;
  assert.equal(g.type, "line");
  if (g.type === "line") { near(point(state,g.from)[1],3); near(point(state,g.to)[1],3); }
  near(state.dimensions.find(d => d.id === measured.id)!.computed.value,30);
  assert.deepEqual(state.offsets[0]!.sides,definition.sides);
  assert.deepEqual(state.offsets[0]!.annotations[0],{position:[8,6]});
  // Reopening the unchanged expression preserves its binding after the name changed.
  await s.modifyCurves(line.curves,{type:"offset",id:definition.id,distance1:"span / 10"});
  const before = await s.state();
  await s.modifyCurves(line.curves,{type:"offset",id:definition.id,distance1:4},{preview:true});
  assert.deepEqual(await s.state(),before); await scene.discardPreview();
  await s.modifyCurves(line.curves,{type:"offset",id:definition.id,mode:"symmetric",distance1:4});
  state=await s.state(); assert.equal(state.offsets[0]!.sides.length,2); assert.deepEqual(state.offsets[0]!.sides[0],definition.sides[0]);
  await s.modifyCurves(line.curves,{type:"offset",id:definition.id,mode:"independent",distance1:5,distance2:6});
  state=await s.state(); const second=state.offsets[0]!.sides[1]!.find(r=>state.entities.find(e=>e.reference.id===r.id)?.geometry.type==="line")!;
  const secondMeasure=await s.dimensions.add("length",{line:second,mode:"driven"});
  await assert.rejects(s.modifyCurves(line.curves,{type:"offset",id:definition.id,distance1:5}),/referenced offset side/);
  await s.remove([secondMeasure.id]);
  await s.modifyCurves(line.curves,{type:"offset",id:definition.id,distance1:5});
  state=await s.state(); assert.equal(state.offsets[0]!.sides.length,1);
  for(let i=0;i<3;i++){await s.recompute();assert.deepEqual((await s.state()).entities,state.entities);}
  await assert.rejects(s.remove([line.id]),/dependent offsets/); assert.deepEqual((await s.state()).entities,state.entities);
  await assert.rejects(s.drag(generated,{from:[0,8],to:[30,8]}),/linked/);
  await assert.rejects(s.transform({entities:[generated],translation:[1,1]}),/linked/);
  await s.remove([generated.id]); assert.equal((await s.state()).offsets.length,0);
  assert.ok((await s.state()).entities.some(e=>e.reference.id===line.id));
});

test("circle and reversed arc offsets follow source dragging, chained offsets and manual recompute", async t => {
  const {scene}=await startCore(t,"linked-offset-circles"),s=await scene.sketches.create(scene.construction.builtin.planes.yz);
  const circle=await s.primitives.add("circle",{center:[0,0],diameter:20});
  const out=await s.modifyCurves(circle.curves,{type:"offset",mode:"symmetric",distance1:2});
  const chain=await s.modifyCurves([out.created[0]!],{type:"offset",distance1:3});
  await s.drag(circle.curves[0]!,{position:[15,0]});
  let state=await s.state(); near(radius(state,out.created[0]!.id),17);near(radius(state,out.created[1]!.id),13);near(radius(state,chain.created[0]!.id),20);
  await s.settings({autoRecompute:false}); await s.drag(circle.curves[0]!,{position:[18,0]});
  near(radius(await s.state(),out.created[0]!.id),17);
  await s.recompute(); near(radius(await s.state(),out.created[0]!.id),20);near(radius(await s.state(),chain.created[0]!.id),23);
  await s.settings({autoRecompute:true});
  const arc=await s.primitives.add("arc",{center:[50,0],radius:10,start:90,end:0});
  const inner=await s.modifyCurves(arc.curves,{type:"offset",distance1:2});
  const arcOffset=(await s.state()).offsets.find(o=>o.sources[0]!.id===arc.id)!;
  await s.modifyCurves([],{type:"offsetAnnotation",id:arcOffset.id,side:0,position:[58,8]});
  await s.drag(arc.curves[0]!,{position:[50,15]});
  near(radius(await s.state(),inner.created[0]!.id),13);
  assert.deepEqual((await s.state()).offsets.find(o=>o.id===arcOffset.id)!.annotations[0],{position:[58,8]});
  state=await s.state();await s.complete();await s.edit();assert.deepEqual((await s.state()).offsets,state.offsets);
  await s.recompute();assert.deepEqual((await s.state()).entities,state.entities);
});

for (const fit of [true,false]) test(`linked ${fit?"fit":"control"} spline offset follows source translation with exact retained curves`, async t => {
  const {scene}=await startCore(t,"linked-offset-spline"),s=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const spline=await s.primitives.add("spline",{points:[[0,0],[5,4],[15,4],[20,0]],fit});
  const out=await s.modifyCurves([spline.curves[0]!],{type:"offset",distance1:1});
  const before=await s.state(),offset=before.offsets[0]!;
  await s.modifyCurves([],{type:"offsetAnnotation",id:offset.id,side:0,position:[8,10]});
  assert.deepEqual((await s.state()).entities,before.entities);
  await s.transform({entities:[spline.curves[0]!],translation:[3,7]});
  const state=await s.state();assert.deepEqual(state.offsets[0]!.sides,offset.sides);
  assert.deepEqual(state.offsets[0]!.annotations[0],{position:[8,10]});
  for(const r of offset.sides.flat()) {
    const g=before.entities.find(e=>e.reference.id===r.id)!.geometry;
    if(g.type==="point") {const p=point(state,r.id);near(p[0],g.position[0]+3,1e-5);near(p[1],g.position[1]+7,1e-5);}
  }
  assert.ok(out.created.length);for(let i=0;i<3;i++){await s.recompute();assert.deepEqual((await s.state()).entities,state.entities);}
});

test("closed linked offset preserves connected exact regions and downstream extrusion", async t => {
  const {core,scene}=await startCore(t,"linked-offset-region"),s=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const rectangle=await s.primitives.add("rectangle",{from:[0,0],to:[20,10],construction:true});
  const result=await s.modifyCurves(rectangle.lines,{type:"offset",distance1:2});
  let state=await s.state();const offset=state.offsets[0]!;
  assert.equal((await s.getProxy()).regions.length,1);
  await s.complete();const solid=await core.solid.extrude(await s.regions.only(),{length1:3}),body=await scene.bodies.get(solid.newSolids[0]!.id);
  near((await body.properties()).volume.value,3*(200+2*2*30+Math.PI*4),1e-5);
  await s.edit();await s.modifyCurves(rectangle.lines,{type:"offset",id:offset.id,distance1:3});
  state=await s.state();assert.deepEqual(state.offsets[0]!.sides,offset.sides);
  for(let i=0;i<3;i++){await s.recompute();assert.deepEqual((await s.state()).entities,state.entities);}
  await assert.rejects(s.modifyCurves(rectangle.lines,{type:"offset",id:offset.id,distance1:-1}),/topology/);assert.deepEqual((await s.state()).entities,state.entities);
  await s.complete();near((await body.properties()).volume.value,3*(200+2*3*30+Math.PI*9),1e-5);assert.ok(result.created.length>=4);
});

test("offset formulas bind renamed cross-sketch dimensions, reject cycles and protect dependencies", async t => {
  const {core}=await startCore(t,"linked-offset-dependencies"),scene=await core.scene.create("cm",{length:"cm",angle:"deg"});
  const a=await scene.sketches.create(scene.construction.builtin.planes.xy,{name:"source"});
  const line=await a.primitives.add("line",{from:[0,0],to:[20,0]});
  const length=await a.dimensions.add("length",{line:line.curves[0],value:20,mode:"driving",name:"width"});await a.complete();
  const b=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle=await b.primitives.add("circle",{center:[0,0],diameter:20,construction:true});
  const out=await b.modifyCurves(circle.curves,{type:"offset",distance1:"sketches[source]dimension[width] / 10"});
  const definition=(await b.state()).offsets[0]!;
  const measured=await b.dimensions.add("radius",{curve:out.created[0],mode:"driven"});await b.complete();
  await a.edit();await a.settings({name:"renamed"});await a.dimensions.update(length.id,{name:"span",value:30});await a.complete();
  near(radius(await b.state(),out.created[0]!.id),13);
  await a.edit();const source=await a.state();
  await assert.rejects(a.dimensions.update(length.id,{value:`sketches[${b.id}]dimension[${measured.id}]`}),/cycle/);assert.deepEqual(await a.state(),source);
  await assert.rejects(a.remove([length.id]),/referenced dimension/);assert.deepEqual(await a.state(),source);await a.cancel();
  await b.edit();let before=await b.state();
  await assert.rejects(b.modifyCurves(circle.curves,{type:"offset",id:definition.id,distance1:measured.id}),/cycle/);assert.deepEqual(await b.state(),before);
  await b.modifyCurves(circle.curves,{type:"offset",id:definition.id,distance1:"0.5"});near(radius(await b.state(),out.created[0]!.id),15);
  before=await b.state();await assert.rejects(b.modifyCurves(circle.curves,{type:"offset",id:definition.id,distance1:-10}));assert.deepEqual(await b.state(),before);
});


test("offset rejects conflicting feedback constraints without detaching generated geometry", async t => {
  const {scene}=await startCore(t,"linked-offset-feedback"),s=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line=await s.primitives.add("line",{from:[0,0],to:[20,0]});
  const out=await s.modifyCurves(line.curves,{type:"offset",distance1:2});
  const before=await s.state();
  await assert.rejects(s.dimensions.add("distance",{curves:[line.curves[0]!,out.created[0]!],value:3,mode:"driving"}),/source geometry|conflict/);
  assert.deepEqual(await s.state(),before);
});

test("offset annotation placement is independent per side, isolated in previews and preserved by edits", async t => {
  const {scene}=await startCore(t,"offset-annotations"),s=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle=await s.primitives.add("circle",{center:[0,0],diameter:20});
  await s.modifyCurves(circle.curves,{type:"offset",mode:"independent",distance1:2,distance2:3});
  const before=await s.state(),offset=before.offsets[0]!,proxy=await s.getProxy();
  const positions: [number,number][]=[[0,15],[-16,0]];
  for(const side of [0,1]) {
    const operation={type:"offsetAnnotation" as const,id:offset.id,side,position:positions[side]!};
    await s.modifyCurves([],operation);await s.modifyCurves([],operation);
  }
  let state=await s.state();
  assert.deepEqual(state.offsets[0]!.annotations,positions.map(position=>({position})));
  assert.deepEqual(state.entities,before.entities);assert.deepEqual(state.dimensions,before.dimensions);assert.deepEqual(state.constraints,before.constraints);
  assert.equal(state.revision,before.revision);assert.deepEqual(state.status,before.status);assert.deepEqual(await s.getProxy(),proxy);
  assert.deepEqual(state.offsets[0]!.distance1,offset.distance1);assert.deepEqual(state.offsets[0]!.distance2,offset.distance2);
  const saved=state;
  for(const operation of [
    {type:"offsetAnnotation" as const,id:offset.id,side:2,position:[0,0] as [number,number]},
    {type:"offsetAnnotation" as const,id:"missing",side:0,position:[0,0] as [number,number]},
    {type:"offsetAnnotation" as const,id:offset.id,side:0,position:[NaN,0] as [number,number]},
  ]) {await assert.rejects(s.modifyCurves([],operation));assert.deepEqual(await s.state(),saved);}
  await assert.rejects(s.modifyCurves(circle.curves,{type:"offsetAnnotation",id:offset.id,side:0,position:[1,2]}));assert.deepEqual(await s.state(),saved);
  await s.modifyCurves([], {type:"offsetAnnotation",id:offset.id,side:0,position:[18,3]}, {preview:true});
  assert.deepEqual(await s.state(),saved);assert.deepEqual((await s.state({preview:true})).offsets[0]!.annotations[0],{position:[18,3]});await scene.discardPreview();
  await s.modifyCurves(circle.curves,{type:"offset",id:offset.id,mode:"independent",distance1:4,distance2:2},{preview:true});
  const preview=await s.state({preview:true});
  await s.modifyCurves([], {type:"offsetAnnotation",id:offset.id,side:1,position:[-18,6]}, {preview:true});
  assert.deepEqual((await s.state({preview:true})).entities,preview.entities);assert.deepEqual(await s.state(),saved);await scene.discardPreview();
  await s.modifyCurves(circle.curves,{type:"offset",id:offset.id,mode:"independent",distance1:4,distance2:2});
  await s.drag(circle.curves[0]!,{position:[15,0]});await s.recompute();state=await s.state();
  assert.deepEqual(state.offsets[0]!.annotations,saved.offsets[0]!.annotations);
  await s.complete();await s.edit();assert.deepEqual((await s.state()).offsets[0]!.annotations,state.offsets[0]!.annotations);
  await s.modifyCurves([], {type:"offsetAnnotation",id:offset.id,side:0,position:[25,8]});await s.cancel();
  assert.deepEqual((await s.state()).offsets[0]!.annotations,state.offsets[0]!.annotations);
});

test("offset draft annotations survive commit and mode changes and reject unavailable sides atomically", async t => {
  const {scene}=await startCore(t,"offset-draft-annotations"),s=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line=await s.primitives.add("line",{from:[0,0],to:[30,0]});
  const operation={type:"offset" as const,distance1:2,annotations:[{position:[8,6] as [number,number]},null] as [{position:[number,number]},null]};
  const before=await s.state();await s.modifyCurves(line.curves,operation,{preview:true});
  const preview=(await s.state({preview:true})).offsets[0]!;assert.deepEqual(await s.state(),before);
  await s.modifyCurves(line.curves,operation);let state=await s.state();assert.deepEqual(state.offsets[0],preview);
  const id=state.offsets[0]!.id;
  await assert.rejects(s.modifyCurves([],{type:"offsetAnnotation",id,side:1,position:[5,5]}));assert.deepEqual(await s.state(),state);
  await s.modifyCurves(line.curves,{type:"offset",id,mode:"symmetric",distance1:3});
  assert.deepEqual((await s.state()).offsets[0]!.annotations,preview.annotations);
  state=await s.state();await assert.rejects(s.modifyCurves(line.curves,{type:"offset",id,distance1:3,annotations:[{position:[Infinity,3]},null]}));assert.deepEqual(await s.state(),state);
});
