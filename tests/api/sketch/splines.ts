import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";
import type { SketchState } from "@pamatcad/sdk";
const point = (state: SketchState, id: string) => {
  const g = state.entities.find(e => e.reference.id === id)!.geometry;
  if (g.type !== "point") throw new Error("Expected point");
  return g.position;
};

test("fit handle modes toggle repeatedly while retaining independent length dimensions and constraints", async t => {
  const { scene } = await startCore(t, "fit-handles");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const curve = await sketch.primitives.add("spline", { points: [[0, 0], [10, 8], [25, 0]], fit: true });
  let state = await sketch.state(); const data = state.splines[0]!, node = data.fitPoints[1]!;
  assert.equal(data.fitPoints.length, 3); assert.equal(data.envelope.length, 4);
  assert.equal(node.mode, "aligned");
  assert.ok(data.envelope.every(r => state.entities.find(e => e.reference.id === r.id)!.construction));
  await assert.rejects(sketch.construction([node.incoming!], false), /construction/);
  await assert.rejects(sketch.remove([data.envelope[0]!.id]), /construction/);
  await sketch.constraints.add("fix", { points: curve.points });
  const incoming = data.envelope[1]!, outgoing = data.envelope[2]!;
  await sketch.constraints.add("horizontal", { points: [node.point, node.incoming!] });
  await sketch.dimensions.add("length", { line: incoming, value: 3, mode: "driving" });
  await sketch.dimensions.add("distance", { points: [node.point, node.outgoing!], value: 6, mode: "driving" });
  state = await sketch.state(); const a = point(state, node.incoming!.id), b = point(state, node.outgoing!.id);
  near(a[0], 7); near(a[1], 8); near(b[0], 16); near(b[1], 8);
  const before = await sketch.getProxy();
  await sketch.splines.setHandleMode(node.point, "independent");
  assert.deepEqual((await sketch.getProxy()).curves, before.curves);
  for (let i = 0; i < 2; i++) {
    await sketch.drag(node.outgoing!, [14, 12]);
    await sketch.splines.setHandleMode(node.point, "aligned");
    state = await sketch.state();
    assert.equal(state.splines[0]!.fitPoints[1]!.mode, "aligned");
    near(point(state, node.incoming!.id)[0], 7); near(point(state, node.incoming!.id)[1], 8);
    near(point(state, node.outgoing!.id)[0], 16); near(point(state, node.outgoing!.id)[1], 8);
    await sketch.splines.setHandleMode(node.point, "independent");
    assert.deepEqual((await sketch.state()).entities, state.entities);
  }
  await sketch.drag(node.outgoing!, [14, 12]);
  await sketch.constraints.add("vertical", { curves: [outgoing] });
  state = await sketch.state(); near(point(state, node.outgoing!.id)[0], 10);
  near(point(state, node.incoming!.id)[0], 7);
  await assert.rejects(sketch.splines.setHandleMode(node.point, "aligned"));
  assert.deepEqual(await sketch.state(), state);
  await sketch.constraints.add("fix", { points: [node.outgoing!] });
  const fixed = point(state, node.outgoing!.id);
  await sketch.drag(node.outgoing!, [20, 20]);
  assert.deepEqual(point(await sketch.state(), node.outgoing!.id), fixed);
});

test("moving a fit point carries its handles and aligned tips rotate independently sized handles", async t => {
  const { scene } = await startCore(t, "fit-drag");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("spline", { points: [[0, 0], [10, 8], [30, 0]], fit: true });
  const state = await sketch.state(), node = state.splines[0]!.fitPoints[1]!;
  await sketch.drag(node.point, [12, 11]);
  let after = await sketch.state();
  for (const ref of [node.point, node.incoming!, node.outgoing!]) {
    const a = point(state, ref.id), b = point(after, ref.id); near(b[0]-a[0], 2); near(b[1]-a[1], 3);
  }
  await sketch.constraints.add("fix", { points: [node.point] });
  const center = point(after, node.point.id), tip = point(after, node.incoming!.id);
  const incomingLength = Math.hypot(tip[0] - center[0], tip[1] - center[1]);
  await sketch.drag(node.outgoing!, [17, 16]);
  after = await sketch.state();
  const a = point(after, node.incoming!.id), b = point(after, node.outgoing!.id), c = point(after, node.point.id);
  near(b[0], 17); near(b[1], 16);
  near((a[0]-c[0])*(b[1]-c[1])-(a[1]-c[1])*(b[0]-c[0]), 0);
  assert.ok((a[0]-c[0])*(b[0]-c[0])+(a[1]-c[1])*(b[1]-c[1]) < 0);
  near(Math.hypot(a[0]-c[0],a[1]-c[1]), incomingLength);
  await sketch.drag(node.outgoing!, [7, 6]);
  after = await sketch.state();
  const rotated = point(after, node.incoming!.id);
  near(point(after, node.outgoing!.id)[0], 7); near(point(after, node.outgoing!.id)[1], 6);
  assert.ok(rotated[0] > c[0] && rotated[1] > c[1]);
  near(Math.hypot(rotated[0]-c[0],rotated[1]-c[1]), incomingLength);
});

test("joining fit curves shares one point, remaps dimensions and retains separate curves", async t => {
  const { scene } = await startCore(t, "fit-join");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await sketch.primitives.add("spline", { points: [[0, 0], [10, 8], [20, 0]], fit: true });
  const b = await sketch.primitives.add("spline", { points: [[20, 0], [30, -5], [40, 0]], fit: true });
  const dim = await sketch.dimensions.add("distance", { points: [sketch.origin, a.points[2]!], value: 20, mode: "driven" });
  const before = await sketch.state();
  await sketch.splines.join({ from: a.points[2]!, to: b.points[0]! });
  const joined = await sketch.state();
  assert.equal(joined.entities.length, before.entities.length-1); assert.equal(joined.splines.length, 2);
  assert.ok(!joined.entities.some(e => e.reference.id === a.points[2]!.id));
  assert.ok(joined.dimensions.find(d => d.id === dim.id)!.parameters.points!.some(r => r.id === b.points[0]!.id));
  assert.equal(joined.splines.find(s => s.curve.id === a.id)!.fitPoints.at(-1)!.point.id, b.points[0]!.id);
  for (const mode of ["independent", "aligned", "independent"] as const) {
    await sketch.splines.setHandleMode(b.points[0]!, mode);
    assert.ok((await sketch.state()).splines.flatMap(s => s.fitPoints).filter(n => n.point.id === b.points[0]!.id).every(n => n.mode === mode));
  }
  await sketch.remove([a.curves[0]!.id]);
  const remaining = await sketch.state(); assert.equal(remaining.splines.length, 1);
  assert.ok(b.points.every(r => remaining.entities.some(e => e.reference.id === r.id)));
  await sketch.complete(); await sketch.edit(); assert.deepEqual((await sketch.state()).entities, remaining.entities);
});

test("conflicting fixed endpoint joins are atomic", async t => {
  const { scene } = await startCore(t, "fit-join-conflict");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await sketch.primitives.add("spline", { points: [[0, 0], [10, 2]], fit: true });
  const b = await sketch.primitives.add("spline", { points: [[15, 2], [25, 0]], fit: true });
  await sketch.constraints.add("fix", { points: [a.points[1]!, b.points[0]!] });
  const before = await sketch.state();
  await assert.rejects(sketch.splines.join({ from: a.points[1]!, to: b.points[0]! }));
  assert.deepEqual(await sketch.state(), before);
});

test("fit self-closure, transforms and copies preserve helpers and exact closed regions", async t => {
  const { core, scene } = await startCore(t, "fit-closed");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await sketch.primitives.add("spline", { points: [[0, 0], [20, 0], [20, 15], [0, 15], [0, 1]], fit: true });
  await sketch.splines.join({ from: a.points.at(-1)!, to: a.points[0]! });
  assert.equal((await sketch.getProxy()).regions.length, 1);
  await sketch.transform({ entities: [a.curves[0]!], translation: [40, 0], angle: 30, copy: true });
  let state = await sketch.state(); assert.equal(state.splines.length, 2);
  assert.ok(state.splines.every(s => s.envelope.length === 8));
  for (let i=0;i<3;i++) { await sketch.recompute(); assert.deepEqual((await sketch.state()).entities, state.entities); }
  await sketch.remove([state.splines.find(s => s.curve.id !== a.id)!.curve.id]);
  await sketch.complete();
  const result = await core.solid.extrude(await sketch.regions.only(), { length1: 2 });
  const body = await scene.bodies.get(result.newSolids[0]!.id), volume = (await body.properties()).volume.value;
  assert.ok(volume > 400);
  await sketch.edit(); await sketch.transform({ entities: [a.curves[0]!], scale: 2 }); await sketch.complete();
  near((await body.properties()).volume.value, volume*4);
});

test("control splines expose a protected consecutive-point polygon and share closing endpoints", async t => {
  const { scene } = await startCore(t, "control-polygon");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await sketch.primitives.add("spline", { points: [[0, 0], [0, 20], [20, 20], [20, 0], [0, 1]] });
  let state = await sketch.state(); const data = state.splines[0]!;
  assert.equal(data.fitPoints.length, 0); assert.equal(data.envelope.length, 4);
  data.envelope.forEach((r,i) => {
    const e = state.entities.find(e => e.reference.id === r.id)!;
    assert.ok(e.construction); assert.deepEqual(e.geometry, {type:"line",from:a.points[i]!.id,to:a.points[i+1]!.id});
  });
  await assert.rejects(sketch.construction(data.envelope, false), /construction/);
  await sketch.splines.join({ from: a.points.at(-1)!, to: a.points[0]! });
  state = await sketch.state(); assert.ok(!state.entities.some(e => e.reference.id === a.points.at(-1)!.id));
  assert.equal((await sketch.getProxy()).regions.length, 1);
  await sketch.remove([a.curves[0]!.id]); assert.equal((await sketch.state()).entities.length, 1);
});

test("splitting a fit spline replaces its handles with exact control polygons", async t => {
  const { scene } = await startCore(t, "fit-split");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await assert.rejects(sketch.primitives.add("spline", { points: [[0, 0], [20, 0]], fit: true, degree: 0 }), /degree/);
  const curve = await sketch.primitives.add("spline", { points: [[0, 0], [10, 8], [20, 0]], fit: true });
  const cutter = await sketch.primitives.add("line", { from: [10, -5], to: [10, 15] });
  const original = (await sketch.state()).splines[0]!;
  await sketch.modifyCurves([curve.curves[0]!, cutter.curves[0]!], { type: "split" });
  const state = await sketch.state();
  assert.equal(state.splines.length, 2);
  assert.ok(original.envelope.every(r => !state.entities.some(e => e.reference.id === r.id)));
  for (const spline of state.splines) {
    assert.equal(spline.fitPoints.length, 0);
    const geometry = state.entities.find(e => e.reference.id === spline.curve.id)!.geometry;
    assert.equal(geometry.type, "spline");
    if (geometry.type !== "spline") assert.fail("Expected spline");
    assert.equal(spline.envelope.length, geometry.points.length - 1);
    assert.ok(spline.envelope.every(r => state.entities.some(e => e.reference.id === r.id && e.construction)));
  }
  const proxy = await sketch.getProxy();
  await sketch.recompute(); assert.deepEqual(await sketch.getProxy(), proxy);
});
