import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core, WebSocketTransport, type Transport, type Method, type Parameters } from "@pamatcad/sdk";

test("positioned split cuts one crossing only, retains other intersections and rejects invalid picks atomically", async t => {
  const { scene } = await startCore(t, "split-position");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await s.primitives.add("line", { from: [0,0], to: [30,0] });
  const b = await s.primitives.add("line", { from: [10,-10], to: [10,10] });
  const c = await s.primitives.add("line", { from: [20,-10], to: [20,10] });
  const refs = [...a.curves,...b.curves,...c.curves], before = await s.state();
  for (const operation of [{ type: "split" as const, position: [4,4] as [number,number] }, { type: "split" as const, position: [10,0] as [number,number], tolerance: -1 }]) {
    await assert.rejects(s.modifyCurves(refs,operation)); assert.deepEqual(await s.state(),before);
  }
  const preview = await s.modifyCurves(refs,{type:"split",position:[10,0]},{preview:true});
  assert.deepEqual(await s.state(),before); await scene.discardPreview();
  const split = await s.modifyCurves(refs,{type:"split",position:[10,0]}); assert.deepEqual(split,preview);
  assert.equal(split.created.length,4); assert.equal(split.removed.length,2);
  let state=await s.state(); assert.deepEqual(state.entities.find(e=>e.reference.id===c.id),before.entities.find(e=>e.reference.id===c.id));
  const all=state.entities.filter(e=>e.geometry.type!=="point").map(e=>e.reference);
  await assert.rejects(s.modifyCurves(all,{type:"split",position:[10,0]}),/split|intersection/);
  assert.deepEqual(await s.state(),state);
  await s.modifyCurves(all,{type:"split",position:[20,0]});
  state=await s.state(); assert.equal(state.entities.filter(e=>e.geometry.type==="line").length,7);
});

test("positioned split on a circle cuts only the chosen crossing and preserves exact geometry", async t => {
  const { scene } = await startCore(t,"split-circle-position");
  const s=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle=await s.primitives.add("circle",{center:[0,0],diameter:20});
  const line=await s.primitives.add("line",{from:[0,-15],to:[0,15]});
  const result=await s.modifyCurves([...circle.curves,...line.curves],{type:"split",position:[0,10]});
  assert.equal(result.created.length,4);
  const state=await s.state(), arcs=state.entities.filter(e=>e.geometry.type==="arc"); assert.equal(arcs.length,2);
  for(const arc of arcs) if(arc.geometry.type==="arc") near(arc.geometry.radius,10);
  assert.equal(state.entities.filter(e=>e.geometry.type==="line").length,2);
  await s.recompute(); assert.deepEqual((await s.state()).entities,state.entities);
});

test("offset open lines and reversed arcs uses the sketch plane and preserves source geometry", async t => {
  const {scene}=await startCore(t,"offset-open");
  for(const plane of [scene.construction.builtin.planes.xy,scene.construction.builtin.planes.yz]) {
    const s=await scene.sketches.create(plane);
    const line=await s.primitives.add("line",{from:[0,0],to:[20,0]}),arc=await s.primitives.add("arc",{center:[30,0],radius:10,start:90,end:0});
    const before=await s.state();
    const parallel=await s.modifyCurves(line.curves,{type:"offset",distance1:"2 mm"});assert.equal(parallel.created.length,1);
    const circular=await s.modifyCurves(arc.curves,{type:"offset",distance1:"2 mm"});assert.equal(circular.created.length,1);
    const state=await s.state();
    for(const ref of [...line.points,...line.curves,...arc.points,...arc.curves]) assert.deepEqual(state.entities.find(e=>e.reference.id===ref.id),before.entities.find(e=>e.reference.id===ref.id));
    const geometry=state.entities.find(e=>e.reference.id===parallel.created[0]!.id)!.geometry;assert.equal(geometry.type,"line");
    if(geometry.type==="line") for(const id of [geometry.from,geometry.to]) {const p=state.entities.find(e=>e.reference.id===id)!.geometry;if(p.type!=="point")assert.fail();near(p.position[1],2);}
    const offsetArc=state.entities.find(e=>e.reference.id===circular.created[0]!.id)!.geometry;assert.equal(offsetArc.type,"arc");if(offsetArc.type==="arc")near(offsetArc.radius,8);
    await s.recompute();assert.deepEqual((await s.state()).entities,state.entities);await s.cancel();
  }
});

for (const neighbor of ["line", "arc", "spline"] as const) test(`fillet retains an editable formula and tangent ${neighbor} connections`, async t => {
  const { scene }=await startCore(t,"fillet-"+neighbor), s=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a=await s.primitives.add("line",{from:[0,0],to:[20,0]});
  const b=neighbor==="line" ? await s.primitives.add("line",{from:[20,0],to:[20,20]}) : neighbor==="arc" ? await s.primitives.add("arc",{center:[30,0],radius:10,start:180,end:90}) : await s.primitives.add("spline",{points:[[20,0],[20,7],[24,14],[25,20]],fit:false});
  const before=await s.state();
  await s.modifyCurves([a.curves[0]!,b.curves[0]!],{type:"fillet",radius:"2 mm"},{preview:true}); assert.deepEqual(await s.state(),before); await scene.discardPreview();
  await s.modifyCurves([a.curves[0]!,b.curves[0]!],{type:"fillet",radius:"2 mm"});
  let state=await s.state(); const radius=state.dimensions.find(d=>d.kind==="radius")!; assert.ok(radius); near(radius.computed.value,2);
  const curve=radius.parameters.curve!;
  assert.equal(state.constraints.filter(c=>c.kind==="tangent"&&c.parameters.curves?.some(r=>r.id===curve.id)).length,2);
  const ids=state.entities.map(e=>e.reference.id);
  const other=await s.primitives.add("line",{from:[-10,-10],to:[-6,-10]});
  await s.constraints.add("fix",{curves:other.curves});
  const driven=await s.dimensions.add("length",{line:other.curves[0],mode:"driven",name:"reference"});
  const source=`sketches[${s.id}]dimension[${driven.id}] / 2`;
  await s.dimensions.update(radius.id,{value:source});
  await s.modifyCurves([curve],{type:"fillet",radius:"3 mm",dimension:radius.id});
  state=await s.state(); near(state.dimensions.find(d=>d.id===radius.id)!.computed.value,3);
  assert.ok(ids.every(id=>state.entities.some(e=>e.reference.id===id)));
  for(let i=0;i<3;i++){ await s.recompute(); assert.deepEqual((await s.state()).entities,state.entities); }
  state=await s.state();
  await assert.rejects(s.modifyCurves([curve],{type:"fillet",radius:-2,dimension:radius.id})); assert.deepEqual(await s.state(),state);
  await s.complete(); await s.edit(); assert.deepEqual((await s.state()).entities,state.entities);
  await s.dimensions.update(radius.id,{value:source}); near((await s.state()).dimensions.find(d=>d.id===radius.id)!.computed.value,2);
});

test("filleted rectangle remains exactly extrudable and radius edits preserve its region", async t => {
  const { core,scene }=await startCore(t,"fillet-region"),s=await scene.sketches.create(scene.construction.builtin.planes.xy);
  const rectangle=await s.primitives.add("rectangle",{from:[0,0],to:[20,20]});
  await s.modifyCurves(rectangle.lines,{type:"fillet",radius:2});
  const state=await s.state(); assert.equal(state.dimensions.length,4);
  const proxy=await s.getProxy(); assert.equal(proxy.regions.length,1);
  for(let i=0;i<3;i++){await s.recompute();assert.deepEqual((await s.state()).entities,state.entities);}
  await s.complete(); const solid=await core.solid.extrude(await s.regions.only(),{length1:2}),body=await scene.bodies.get(solid.newSolids[0]!.id);
  near((await body.properties()).volume.value,2*(400-4*(4-Math.PI)),1e-5);
});

test("interactive fillet, linked offset and positioned split replay public commands with identical geometry", { skip: process.env.PAMATCAD_TEST_RUNTIME === "wasm" }, async t => {
  const commands: { method: Method; params: Parameters<Method> }[] = [], responses: unknown[] = [];
  const { url } = await startCore(t, "interactive-edit-replay");
  const transport = await WebSocketTransport.connect(url); t.after(() => transport.close());
  const core = new Core({ async request(method, params) {
    commands.push(JSON.parse(JSON.stringify({ method, params })));
    const result = await transport.request(method, params); responses.push(result); return result;
  }, close() { transport.close(); } });
  const scene = await core.scene.create("interactive-edit-replay"), s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const rectangle = await s.primitives.add("rectangle", { from: [0,0], to: [20,20] });
  await s.modifyCurves(rectangle.lines, { type: "fillet", radius: "2 mm" });
  const radius = (await s.state()).dimensions[0]!;
  await s.dimensions.update(radius.id, { value: "2.5 mm" }); await s.recompute(); await s.getProxy();
  const a = await s.primitives.add("line", { from: [30,0], to: [40,10], construction: true });
  const b = await s.primitives.add("line", { from: [30,10], to: [40,0], construction: true });
  await s.modifyCurves([...a.curves,...b.curves], { type: "split", position: [35,5] });
  const source = await s.primitives.add("circle", { center: [60,60], diameter: 10, construction: true });
  const offset = await s.modifyCurves(source.curves, { type: "offset", distance1: "2 mm" });
  await s.construction(offset.created, true);
  const definition = (await s.state()).offsets[0]!;
  await s.modifyCurves(source.curves, { type: "offset", id: definition.id, distance1: "3 mm" });
  await s.drag(source.curves[0]!, { position: [66,60] }); await s.recompute();
  await s.modifyCurves([], { type: "offsetAnnotation", id: definition.id, side: 0, position: [60,72] });
  await s.state();
  await s.complete(); const solid = await core.solid.extrude(await s.regions.only(), { length1: 2 });
  await (await scene.bodies.get(solid.newSolids[0]!.id)).properties();
  const directory = await mkdtemp(join(tmpdir(), "pamatcad-interactive-edit-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "commands.jsonl"); await writeFile(file, commands.map((command,i)=>JSON.stringify({jsonrpc:"2.0",id:i+1,...command})).join("\n"));
  const replay = await startCore(t, "interactive-edit-replay"), target = await WebSocketTransport.connect(replay.url); t.after(()=>target.close());
  const actual=[];
  for(const line of (await readFile(file,"utf8")).split("\n")) { const command=JSON.parse(line) as typeof commands[number]; actual.push(await target.request(command.method,command.params)); }
  assert.deepEqual(actual,responses);
});

test("Remove trims one line interval, preserves cutters and endpoints, and supports preview and repeated clicks", async t => {
  const { scene } = await startCore(t, "remove-line");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [0, 0], to: [30, 0], construction: true });
  const cutters = [];
  for (const x of [10, 20]) cutters.push(await sketch.primitives.add("line", { from: [x, -5], to: [x, 5] }));
  const fixed = await sketch.constraints.add("fix", { curves: cutters.flatMap(c => c.curves) });
  const before = await sketch.state();
  const operation = { type: "remove", position: [15, 0] } as const;
  const preview = await sketch.modifyCurves(line.curves, { ...operation, position: [...operation.position] }, { preview: true });
  assert.equal(preview.created.length, 2);
  assert.deepEqual(await sketch.state(), before);
  await scene.discardPreview();
  await assert.rejects(sketch.state({ preview: true }), /cached/);
  const result = await sketch.modifyCurves(line.curves, { ...operation, position: [...operation.position] });
  assert.deepEqual(result, preview);
  let state = await sketch.state();
  for (const ref of [...line.points, ...cutters.flatMap(c => [...c.points, ...c.curves])])
    assert.deepEqual(state.entities.find(e => e.reference.id === ref.id), before.entities.find(e => e.reference.id === ref.id));
  assert.ok(state.constraints.some(c => c.id === fixed.id));
  const segments = result.created.map(ref => {
    const e = state.entities.find(e => e.reference.id === ref.id)!;
    assert.ok(e.construction);
    if (e.geometry.type !== "line") assert.fail("Expected retained line");
    return [e.geometry.from, e.geometry.to].map(id => {
      const p = state.entities.find(e => e.reference.id === id)!.geometry;
      if (p.type !== "point") assert.fail("Expected endpoint");
      return p.position[0];
    }).sort((a, b) => a - b);
  }).sort((a, b) => a[0]! - b[0]!);
  assert.deepEqual(segments, [[0, 10], [20, 30]]);
  for (const ref of result.created) await sketch.modifyCurves([ref], { type: "remove", position: [0, 0] });
  state = await sketch.state();
  assert.ok(line.points.every(p => !state.entities.some(e => e.reference.id === p.id)));
  assert.deepEqual(state.entities.filter(e => e.geometry.type === "line").map(e => e.reference.id).sort(), cutters.flatMap(c => c.curves.map(r => r.id)).sort());
});

test("Remove rejects ambiguous, point, multiple and dimension-dependent targets atomically", async t => {
  const { scene } = await startCore(t, "remove-invalid");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [0, 0], to: [30, 0] });
  const cutter = await sketch.primitives.add("line", { from: [10, -5], to: [10, 5] });
  const before = await sketch.state();
  await assert.rejects(sketch.modifyCurves(line.curves, { type: "remove", position: [10, 0] }), /intersection/);
  await assert.rejects(sketch.modifyCurves(line.points, { type: "remove", position: [0, 0] }), /one curve/);
  await assert.rejects(sketch.modifyCurves([line.points[0]!], { type: "remove", position: [0, 0] }), /curve/);
  await assert.rejects(sketch.modifyCurves([...line.curves, ...cutter.curves], { type: "remove", position: [0, 0] }), /one curve/);
  await assert.rejects(sketch.modifyCurves([], { type: "remove", position: [0, 0] }), /one curve/);
  assert.deepEqual(await sketch.state(), before);
  const dimension = await sketch.dimensions.add("length", { line: line.curves[0], name: "span", mode: "driving", value: 30 });
  await sketch.dimensions.add("length", { line: cutter.curves[0], mode: "driving", value: "span / 3" });
  const dependent = await sketch.state();
  await assert.rejects(sketch.modifyCurves(line.curves, { type: "remove", position: [5, 0] }), /referenced dimension/);
  assert.deepEqual(await sketch.state(), dependent);
  await sketch.dimensions.remove(dependent.dimensions.find(d => d.id !== dimension.id)!.id);
  const result = await sketch.modifyCurves(line.curves, { type: "remove", position: [10 - 1e-4, 0] });
  assert.deepEqual(result.removedDimensions, [dimension.id]);
  assert.equal(result.created.length, 1);
});

for (const kind of ["circle", "ellipse"] as const) {
  test(`Remove keeps an exact ${kind} half across its seam on a rotated sketch plane`, async t => {
    const { core, scene } = await startCore(t, "remove-" + kind);
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.yz);
    const curve = kind === "circle"
      ? await sketch.primitives.add("circle", { center: [0, 0], diameter: 20 })
      : await sketch.primitives.add("ellipse", { center: [0, 0], major: 10, minor: 5 });
    const height = kind === "circle" ? 10 : 5;
    const cutter = await sketch.primitives.add("line", { from: [0, -height], to: [0, height] });
    const before = await sketch.state();
    const result = await sketch.modifyCurves([curve.curves[0]!], { type: "remove", position: [-10, 0] });
    assert.equal(result.created.length, 1, "Artificial seam must not split the retained interval");
    const state = await sketch.state();
    assert.deepEqual(state.entities.find(e => e.reference.id === cutter.curves[0]!.id), before.entities.find(e => e.reference.id === cutter.curves[0]!.id));
    const proxy = await sketch.getProxy();
    assert.equal(proxy.regions.length, 1);
    const retained = proxy.curves.find(c => c.entity.id === result.created[0]!.id)!;
    for (const p of retained.points) {
      near((p[1] / 10) ** 2 + (p[2] / height) ** 2, 1);
      assert.ok(p[1] >= -1e-6, "Retain the right half in the YZ sketch frame");
    }
    for (let repeat = 0; repeat < 3; repeat++) { await sketch.recompute(); assert.deepEqual((await sketch.state()).entities, state.entities); }
    await sketch.complete(); await sketch.edit(); assert.deepEqual((await sketch.state()).entities, state.entities); await sketch.complete();
    const solid = await core.solid.extrude(await sketch.regions.only(), { length1: 2 });
    const body = await scene.bodies.get(solid.newSolids[0]!.id);
    assert.equal((await body.faces.all()).length, 4);
    if (kind === "circle") near((await body.properties()).volume.value, Math.PI * 100, 1e-5);
  });
}

test("Remove handles isolated curves, a single closed-curve intersection and tangency", async t => {
  const { scene } = await startCore(t, "remove-whole");
  for (const kind of ["line", "circle", "ellipse", "spline", "tangent", "seam"] as const) {
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const curve = kind === "line" ? await sketch.primitives.add("line", { from: [0, 0], to: [10, 0] })
      : kind === "ellipse" ? await sketch.primitives.add("ellipse", { center: [0, 0], major: 10, minor: 5 })
      : kind === "spline" ? await sketch.primitives.add("spline", { points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true })
      : await sketch.primitives.add("circle", { center: [0, 0], diameter: 20 });
    const cutter = kind === "tangent" ? await sketch.primitives.add("line", { from: [-20, 10], to: [20, 10] })
      : kind === "seam" ? await sketch.primitives.add("line", { from: [10, 0], to: [20, 0] }) : undefined;
    const result = await sketch.modifyCurves([curve.curves[0]!], { type: "remove", position: [0, -10] });
    assert.deepEqual(result.created, [], kind);
    const state = await sketch.state();
    assert.equal(state.entities.length, cutter ? 4 : 1, kind + " cleans up owned helpers and unused points");
    assert.ok(state.entities.some(e => e.reference.id === "origin"));
    await sketch.cancel();
  }
});

test("Remove trims arcs and fit/control splines while excluding their protected helper polygons", async t => {
  const { scene } = await startCore(t, "remove-open-curves");
  for (const kind of ["arc", "fit", "control", "closed-fit", "closed-control"] as const) {
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const closed = kind.startsWith("closed");
    const curve = kind === "arc" ? await sketch.primitives.add("arc", { center: [10, 0], radius: 10, start: 0, end: 180 })
      : await sketch.primitives.add("spline", { points: closed ? [[0, 0], [20, 0], [20, 20], [0, 20]] : [[0, 0], [5, 10], [15, 10], [20, 0]], fit: kind.endsWith("fit"), closed });
    const cutter = await sketch.primitives.add("line", { from: [10, -10], to: [10, 30] });
    const before = await sketch.state();
    if (kind !== "arc") {
      await assert.rejects(sketch.modifyCurves([before.splines[0]!.envelope[0]!], { type: "remove", position: [0, 0] }), /construction/);
      assert.deepEqual(await sketch.state(), before);
    }
    const result = await sketch.modifyCurves([curve.curves[0]!], { type: "remove", position: [20, 5] });
    assert.ok(result.created.length >= 1 && result.created.length <= 2, kind);
    const proxy = await sketch.getProxy();
    const kept = proxy.curves.filter(c => result.created.some(r => r.id === c.entity.id));
    assert.ok(kept.every(c => c.points.every(p => p[0] <= 10 + 1e-6)), kind);
    assert.ok(kept.some(c => c.points.some(p => p[0] < 5)), kind);
    const state = await sketch.state();
    assert.deepEqual(state.entities.find(e => e.reference.id === cutter.curves[0]!.id), before.entities.find(e => e.reference.id === cutter.curves[0]!.id));
    assert.ok(before.splines.flatMap(s => s.envelope).every(r => !state.entities.some(e => e.reference.id === r.id)));
    await sketch.recompute(); assert.deepEqual(await sketch.getProxy(), proxy);
    await sketch.cancel();
  }
});

test("Remove uses projected boundaries without changing their read-only geometry", async t => {
  const { core, scene } = await startCore(t, "remove-projection");
  const source = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await source.primitives.add("rectangle", { from: [0, 0], to: [10, 10] }); await source.complete();
  const profile = await source.regions.only(), solid = await core.solid.extrude(profile, { length1: 2 });
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.projections.add({ type: "face", reference: await solid.faces.endCap1({ profile }).only() });
  const line = await sketch.primitives.add("line", { from: [-5, 5], to: [15, 5] });
  const before = await sketch.state(), projected = before.entities.filter(e => e.projected);
  await assert.rejects(sketch.modifyCurves([projected.find(e => e.geometry.type === "line")!.reference], { type: "remove", position: [0, 5] }), /read-only/);
  assert.deepEqual(await sketch.state(), before);
  const result = await sketch.modifyCurves(line.curves, { type: "remove", position: [5, 5] });
  assert.equal(result.created.length, 2);
  assert.deepEqual((await sketch.state()).entities.filter(e => e.projected), projected);
});

test("arc deletion cleanup and its surviving exact shape replay the same public commands", { skip: process.env.PAMATCAD_TEST_RUNTIME === "wasm" }, async t => {
  const commands: { jsonrpc: "2.0"; id: number; method: Method; params: Parameters<Method> }[] = [];
  const responses: unknown[] = [], snapshots = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    const { url } = await startCore(t, "arc-delete-replay");
    const transport = await WebSocketTransport.connect(url); t.after(() => transport.close());
    const recording: Transport = { async request(method, params) {
      if (repeat === 0) commands.push(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: commands.length + 1, method, params })));
      const result = await transport.request(method, params);
      if (repeat === 0) responses.push(result);
      return result;
    }, close() { transport.close(); } };
    const core = new Core(recording), scene = await core.scene.create("Arc cleanup");
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const arc = await sketch.primitives.add("arc", { center: [0, 0], radius: 5, start: 0, end: 180 });
    await sketch.dimensions.add("radius", { curve: arc.curves[0], value: 5, mode: "driving" });
    await sketch.primitives.add("circle", { center: [40, 0], diameter: 8 });
    await sketch.remove([arc.curves[0]!.id]);
    const state = await sketch.state();
    assert.ok(arc.points.every(r => !state.entities.some(e => e.reference.id === r.id)));
    await sketch.recompute(); await sketch.recompute();
    await sketch.complete(); await sketch.edit(); assert.deepEqual((await sketch.state()).entities, state.entities); await sketch.complete();
    const result = await core.solid.extrude(await sketch.regions.only(), { length1: 2 });
    const body = await scene.bodies.get(result.newSolids[0]!.id), properties = await body.properties();
    near(properties.volume.value, 32 * Math.PI);
    snapshots.push({ state: await sketch.state(), proxy: await scene.getProxyFor(result.newSolids[0]!), properties });
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
  const directory = await mkdtemp(join(tmpdir(), "pamatcad-arc-delete-replay-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "commands.jsonl"); await writeFile(file, commands.map(command => JSON.stringify(command)).join("\n"));
  const { url } = await startCore(t, "arc-delete-replay"), transport = await WebSocketTransport.connect(url); t.after(() => transport.close());
  const replayed = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const command = JSON.parse(line) as typeof commands[number]; replayed.push(await transport.request(command.method, command.params));
  }
  assert.deepEqual(replayed, responses);
});

test("Remove produces a repeatable exact extrusion and replays captured public commands through the CLI", { skip: process.env.PAMATCAD_TEST_RUNTIME === "wasm" }, async t => {
  const commands: { jsonrpc: "2.0"; id: number; method: Method; params: Parameters<Method> }[] = [];
  const responses: unknown[] = [], snapshots = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    const { url } = await startCore(t, "remove-replay");
    const transport = await WebSocketTransport.connect(url); t.after(() => transport.close());
    const recording: Transport = { async request(method, params) {
      if (repeat === 0) commands.push(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: commands.length + 1, method, params })));
      const result = await transport.request(method, params);
      if (repeat === 0) responses.push(result);
      return result;
    }, close() { transport.close(); } };
    const core = new Core(recording), scene = await core.scene.create("Trim rectangle");
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const bottom = (await sketch.primitives.add("line", { from: [-5, 0], to: [15, 0] })).curves[0]!;
    for (const [from, to] of [[[0, 0], [0, 10]], [[0, 10], [10, 10]], [[10, 10], [10, 0]]] as [[number, number], [number, number]][])
      await sketch.primitives.add("line", { from, to });
    await sketch.modifyCurves([bottom], { type: "remove", position: [-2, 0] });
    const state = await sketch.state();
    // Find the right overhang among the retained intervals from the first removal.
    const right = state.entities.find(e => e.geometry.type === "line" && [e.geometry.from, e.geometry.to].some(id => {
      const p = state.entities.find(e => e.reference.id === id)!.geometry;
      return p.type === "point" && p.position[0] === 15;
    }))!;
    await sketch.modifyCurves([right.reference], { type: "remove", position: [12, 0] });
    await sketch.complete();
    const result = await core.solid.extrude(await sketch.regions.only(), { length1: 3 });
    const body = await scene.bodies.get(result.newSolids[0]!.id);
    near((await body.properties()).volume.value, 300);
    assert.equal((await body.faces.all()).length, 6);
    snapshots.push({ state: await sketch.state(), proxy: await scene.getProxyFor(result.newSolids[0]!), properties: await body.properties() });
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
  const directory = await mkdtemp(join(tmpdir(), "pamatcad-remove-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "remove.jsonl");
  await writeFile(file, commands.map(command => JSON.stringify(command)).join("\n"));
  const { url } = await startCore(t, "remove-replay");
  const transport = await WebSocketTransport.connect(url); t.after(() => transport.close());
  const replayed = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const command = JSON.parse(line) as typeof commands[number];
    replayed.push(await transport.request(command.method, command.params));
  }
  assert.deepEqual(replayed, responses);
});
test("split intersects ordinary lines and preserves unrelated entity IDs", async (t) => {
  const { scene } = await startCore(t, "split-sketch");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await sketch.primitives.add("line", { from: [0, 0], to: [10, 10] });
  const b = await sketch.primitives.add("line", { from: [0, 10], to: [10, 0] });
  const other = await sketch.primitives.add("circle", { center: [30, 30], diameter: 4 });
  const result = await sketch.modifyCurves([...a.curves, ...b.curves], { type: "split" });
  assert.equal(result.removed.length, 2);
  assert.equal(result.created.length, 4);
  const state = await sketch.state();
  assert.ok(state.entities.some(e => e.reference.id === other.curves[0]!.id));
  const lines = state.entities.filter(e => result.created.some(r => r.id === e.reference.id));
  assert.equal(lines.length, 4);
  for (const e of lines) {
    assert.equal(e.geometry.type, "line");
    if (e.geometry.type !== "line") {
      continue;
    }
    const g = e.geometry;
    const p = state.entities.find(p => p.reference.id === g.from)!, q = state.entities.find(p => p.reference.id === g.to)!;
    assert.equal(p.geometry.type, "point");
    assert.equal(q.geometry.type, "point");
    if (p.geometry.type === "point" && q.geometry.type === "point") {
      near(Math.hypot(q.geometry.position[0] - p.geometry.position[0], q.geometry.position[1] - p.geometry.position[1]), Math.sqrt(50));
    }
  }
});
test("offset a circle on both sides without changing its source", async (t) => {
  const { scene } = await startCore(t, "offset-sketch");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [0, 0], diameter: 20 });
  const result = await sketch.modifyCurves(circle.curves, { type: "offset", distance1: "2 mm", distance2: "3 mm" });
  assert.deepEqual(result.removed, []);
  assert.equal(result.created.length, 2);
  const radii = (await sketch.state()).entities.filter(e => e.geometry.type === "circle").map(e => e.geometry.type === "circle" ? e.geometry.radius : 0).sort((a, b) => a - b);
  assert.deepEqual(radii.map(r => Math.round(r)), [7, 10, 12]);
});
test("round a corner with one radius and retain exact arcs", async (t) => {
  const { scene } = await startCore(t, "round-sketch");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await sketch.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const b = await sketch.primitives.add("line", { from: [10, 0], to: [10, 10] });
  const result = await sketch.modifyCurves([...a.curves, ...b.curves], { type: "rounding", radius: 2 });
  assert.equal(result.removed.filter(r => [...a.curves, ...b.curves].some(c => c.id === r.id)).length, 2);
  assert.equal(result.created.length, 3);
  const state = await sketch.state();
  assert.ok(!state.entities.some(e => e.geometry.type === "point" && e.geometry.position[0] === 10 && e.geometry.position[1] === 0), "Rounding removes the obsolete corner points");
  const arc = state.entities.find(e => e.geometry.type === "arc")!;
  assert.ok(arc);
  if (arc.geometry.type === "arc") {
    near(arc.geometry.radius, 2);
  }
});
test("move, rotate and scale copies retain source geometry and internal dimension bindings", async (t) => {
  const { scene } = await startCore(t, "transform-sketch");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [10, 0], diameter: 10 });
  await sketch.dimensions.add("radius", { curve: circle.curves[0], name: "radius", mode: "driving", value: 5 });
  const copy = await sketch.transform({ entities: circle.curves, copy: true, pivot: [0, 0], translation: [0, 10], angle: 90, scale: "4/2" });
  const state = await sketch.state();
  const source = state.entities.find(e => e.reference.id === circle.curves[0]!.id)!, target = state.entities.find(e => e.reference.id === copy[0]!.id)!;
  if (source.geometry.type !== "circle" || target.geometry.type !== "circle") {
    assert.fail("Expected two circles");
  }
  near(source.geometry.radius, 5);
  near(target.geometry.radius, 10);
  const targetGeometry = target.geometry;
  const center = state.entities.find(e => e.reference.id === targetGeometry.center)!;
  if (center.geometry.type !== "point") {
    assert.fail("Expected center");
  }
  near(center.geometry.position[0], 0);
  near(center.geometry.position[1], 30);
  assert.equal(state.dimensions.length, 2);
});
test("manual recomputation exposes stale state and per-entity degrees of freedom", async (t) => {
  const { scene } = await startCore(t, "sketch-dof");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [0, 0], to: [10, 0] });
  let state = await sketch.state();
  assert.equal(state.status.entities.find(e => e.entity.id === line.curves[0]!.id)?.degreesOfFreedom, 4);
  await sketch.constraints.add("coincident", { points: [sketch.origin, line.points[0]!] });
  state = await sketch.state();
  assert.equal(state.status.entities.find(e => e.entity.id === line.curves[0]!.id)?.degreesOfFreedom, 2);
  await sketch.settings({ autoRecompute: false });
  await sketch.constraints.add("horizontal", { curves: line.curves });
  assert.equal((await sketch.state()).status.state, "stale");
  await sketch.recompute();
  state = await sketch.state();
  assert.equal(state.status.entities.find(e => e.entity.id === line.curves[0]!.id)?.degreesOfFreedom, 1);
});
test("a transform blocked by orientation constraints fails atomically", async (t) => {
  const { scene } = await startCore(t, "constrained-transform");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const rectangle = await sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
  const before = await sketch.state();
  const transform = { entities: rectangle.curves, pivot: [0, 0] as [number, number], angle: 45 };
  await assert.rejects(sketch.transform(transform), /Constraints prevent the requested transform/);
  assert.deepEqual(await sketch.state(), before);
  await sketch.constraints.remove(before.constraints.find(c => c.kind === "horizontal")!.id);
  await sketch.transform(transform);
  const after = await sketch.state();
  const points = rectangle.points.map(r => after.entities.find(e => e.reference.id === r.id)!.geometry);
  assert.ok(points.every(g => g.type === "point"));
  assert.ok(points.some(g => g.type === "point" && Math.abs(g.position[1] - Math.sqrt(200)) < 1e-7));
});

test("repeated perpendicular constraints return the original without mutating the sketch or preview", async t => {
  const { scene } = await startCore(t, "duplicate-perpendicular");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const rectangle = await sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
  const parameters = { curves: [rectangle.curves[0]!, rectangle.curves[1]!] };
  const original = await sketch.constraints.add("perpendicular", parameters);
  const before = await sketch.state(), proxy = await sketch.getProxy();
  const draft = await sketch.primitives.add("point", { position: [30, 40] }, { preview: true });
  const preview = await sketch.state({ preview: true });
  assert.deepEqual(await sketch.constraints.add("perpendicular", parameters), original);
  assert.deepEqual(await sketch.constraints.add("perpendicular", { curves: [...parameters.curves].reverse() }), original);
  assert.deepEqual(await sketch.state(), before);
  assert.deepEqual(await sketch.getProxy(), proxy);
  assert.deepEqual(await sketch.state({ preview: true }), preview);
  const committed = await sketch.primitives.add("point", { position: [30, 40] });
  assert.deepEqual(committed, draft, "Duplicates must not consume IDs");
  // An implied but distinct perpendicular pair still has its own identity.
  const distinct = await sketch.constraints.add("perpendicular", { curves: [rectangle.curves[3]!, rectangle.curves[0]!] });
  assert.notEqual(distinct.id, original.id);
  await sketch.settings({ autoRecompute: false });
  const manual = await sketch.state();
  assert.deepEqual(await sketch.constraints.add("perpendicular", parameters), original);
  assert.deepEqual(await sketch.state(), manual);
  await assert.rejects(sketch.constraints.add("perpendicular", { curves: [{ ...parameters.curves[0]!, sketchId: "missing" }, parameters.curves[1]!] }), /belong/);
  assert.deepEqual(await sketch.state(), manual);
  await sketch.complete();
  await assert.rejects(sketch.constraints.add("perpendicular", parameters), /complete/);
  await sketch.edit();
  const reopened = await sketch.state();
  assert.deepEqual(await sketch.constraints.add("perpendicular", parameters), original);
  assert.deepEqual(await sketch.state(), reopened);
});

test("repeated fixed constraints retain their ID and fixed values", async t => {
  const { scene } = await startCore(t, "duplicate-fix");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [3, 4], to: [13, 4] });
  const original = await sketch.constraints.add("fix", { points: line.points });
  const before = await sketch.state(), proxy = await sketch.getProxy();
  assert.deepEqual(await sketch.constraints.add("fix", { points: line.points }), original);
  assert.deepEqual(await sketch.constraints.add("fix", { points: [...line.points].reverse() }), original);
  assert.deepEqual(await sketch.state(), before);
  assert.deepEqual(await sketch.getProxy(), proxy);
  await sketch.drag(line.points[0]!, [20, 20]);
  assert.deepEqual((await sketch.state()).entities, before.entities);
  const curveFix = await sketch.constraints.add("fix", { curves: line.curves });
  assert.notEqual(curveFix.id, original.id);
  assert.deepEqual(await sketch.constraints.add("fix", { curves: line.curves }), curveFix);
  await sketch.complete();
  await sketch.edit();
  const reopened = await sketch.state();
  assert.deepEqual(await sketch.constraints.add("fix", { points: line.points }), original);
  assert.deepEqual(await sketch.state(), reopened);
});
