import assert from "node:assert/strict";
import { test } from "node:test";
import type { SketchState } from "@pamatcad/sdk";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core, WebSocketTransport, type Transport, type Method, type Parameters } from "@pamatcad/sdk";

function pointsAt(state: SketchState, x: number, y: number) {
  return state.entities.filter(e => e.geometry.type === "point" &&
    Math.abs(e.geometry.position[0] - x) < 1e-7 && Math.abs(e.geometry.position[1] - y) < 1e-7).map(e => e.reference);
}
function position(state: SketchState, id: string) {
  const entity = state.entities.find(e => e.reference.id === id)!;
  assert.equal(entity.geometry.type, "point");
  if (entity.geometry.type !== "point") throw new Error("Expected point");
  return entity.geometry.position;
}
function sameContract(before: SketchState, after: SketchState) {
  assert.deepEqual(after.constraints, before.constraints);
  assert.deepEqual(after.dimensions, before.dimensions);
  assert.deepEqual(after.entities.map(e => e.reference), before.entities.map(e => e.reference));
  assert.deepEqual(after.status, before.status);
}

function edgeAt(state: SketchState, axis: 0 | 1, coordinate: number) {
  const edge = state.entities.find(e => e.geometry.type === "line" &&
    [e.geometry.from, e.geometry.to].every(id => Math.abs(position(state, id)[axis] - coordinate) < 1e-7));
  assert.ok(edge && edge.geometry.type === "line");
  return { reference: edge.reference, from: position(state, edge.geometry.from), to: position(state, edge.geometry.to) };
}

test("dragging the top-left rectangle corner reaches the cursor and preserves the opposite corner", async t => {
  const { scene, core } = await startCore(t, "drag-top-left");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [-15, 15], to: [15, -15] });
  const before = await sketch.state();
  const corner = pointsAt(before, -15, 15)[0]!;
  const after = await sketch.drag(corner, [-20, 20]);
  assert.equal(pointsAt(after, -20, 20).length, 2);
  assert.equal(pointsAt(after, 15, -15).length, 2);
  assert.equal(pointsAt(after, -20, -15).length, 2);
  assert.equal(pointsAt(after, 15, 20).length, 2);
  sameContract(before, after);
  const repeated = await sketch.drag(corner, [-20, 20]);
  for (const e of after.entities.filter(e => e.geometry.type === "point")) {
    const actual = position(repeated, e.reference.id), expected = position(after, e.reference.id);
    near(actual[0], expected[0]); near(actual[1], expected[1]);
  }
  await sketch.complete();
  const result = await core.solid.extrude(await sketch.regions.only(), { length1: 2 });
  near((await (await scene.bodies.get(result.newSolids[0]!.id)).properties()).volume.value, 2450);
});

test("dragging the bottom-right rectangle corner reaches the cursor and preserves the opposite corner", async t => {
  const { scene } = await startCore(t, "drag-bottom-right");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [-15, 15], to: [15, -15] });
  const before = await sketch.state(), corner = pointsAt(before, 15, -15)[0]!;
  const after = await sketch.drag(corner, [20, -20]);
  assert.equal(pointsAt(after, 20, -20).length, 2);
  assert.equal(pointsAt(after, -15, 15).length, 2);
  assert.equal(pointsAt(after, -15, -20).length, 2);
  assert.equal(pointsAt(after, 20, 15).length, 2);
  sameContract(before, after);
  const repeated = await sketch.drag(corner, [20, -20]);
  for (const e of after.entities.filter(e => e.geometry.type === "point")) {
    const actual = position(repeated, e.reference.id), expected = position(after, e.reference.id);
    near(actual[0], expected[0]); near(actual[1], expected[1]);
  }
});

test("dragging either coincident endpoint gives the same rectangle geometry", async t => {
  const { scene } = await startCore(t, "drag-coincident-endpoints");
  const a = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const b = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await a.primitives.add("rectangle", { from: [-15, 15], to: [15, -15] });
  await b.primitives.add("rectangle", { from: [-15, 15], to: [15, -15] });
  const first = pointsAt(await a.state(), 15, -15)[0]!;
  const second = pointsAt(await b.state(), 15, -15)[1]!;
  const left = await a.drag(first, [25, -20]);
  const right = await b.drag(second, [25, -20]);
  assert.deepEqual(left.entities.map(e => e.geometry), right.entities.map(e => e.geometry));
  assert.equal(pointsAt(right, -15, 15).length, 2);
});

test("dragging a fixed point preserves its permanent constraints and geometry", async t => {
  const { scene } = await startCore(t, "drag-fixed-point");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const point = (await sketch.primitives.add("point", { position: [10, 20] })).points[0]!;
  await sketch.constraints.add("fix", { points: [point] });
  const before = await sketch.state();
  const after = await sketch.drag(point, [30, 40]);
  assert.deepEqual(after.entities, before.entities);
  sameContract(before, after);
});

test("dragging a point on a fixed circle follows its permitted motion", async t => {
  const { scene } = await startCore(t, "drag-point-on-circle");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [0, 0], diameter: 20 });
  await sketch.constraints.add("fix", { curves: circle.curves });
  const point = (await sketch.primitives.add("point", { position: [10, 0] })).points[0]!;
  const unrelated = (await sketch.primitives.add("point", { position: [-20, 20] })).points[0]!;
  await sketch.constraints.add("pointOnCurve", { points: [point], curves: circle.curves });
  const before = await sketch.state();
  const after = await sketch.drag(point, [8, 8]);
  const actual = position(after, point.id);
  near(actual[0], Math.sqrt(50), 1e-6); near(actual[1], Math.sqrt(50), 1e-6);
  assert.deepEqual(position(after, unrelated.id), [-20, 20]);
  sameContract(before, after);
});

test("dragging the upper endpoint of a spaced vertical line follows its remaining freedom", async t => {
  const { scene } = await startCore(t, "drag-spaced-vertical-upper");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const construction = await sketch.primitives.add("line", { from: [0, -10], to: [0, 10], construction: true });
  await sketch.constraints.add("vertical", { curves: construction.curves });
  await sketch.constraints.add("pointOnCurve", { points: [sketch.origin], curves: construction.curves });
  const line = await sketch.primitives.add("line", { from: [12.09, -15], to: [12.09, 8] });
  await sketch.constraints.add("vertical", { curves: line.curves });
  await sketch.dimensions.add("distance", { curves: [construction.curves[0]!, line.curves[0]!], value: 12.09, mode: "driving" });
  const before = await sketch.state(), upper = line.points[1]!;
  assert.equal(before.status.entities.find(e => e.entity.id === upper.id)!.degreesOfFreedom, 1);
  const after = await sketch.drag(upper, [14, 15]);
  near(position(after, upper.id)[0], 12.09); near(position(after, upper.id)[1], 15);
  sameContract(before, after);
  for (const e of before.entities.filter(e => e.reference.id !== upper.id)) {
    const actual = after.entities.find(a => a.reference.id === e.reference.id)!;
    assert.deepEqual({ ...actual, geometry: e.geometry }, e);
    if (e.geometry.type === "point") {
      near(position(after, e.reference.id)[0], e.geometry.position[0]);
      near(position(after, e.reference.id)[1], e.geometry.position[1]);
    } else assert.deepEqual(actual.geometry, e.geometry);
  }
  // Even sub-pixel horizontal jitter must not prevent the allowed vertical motion.
  const jittered = await sketch.drag(upper, [12.091, 16]);
  near(position(jittered, upper.id)[0], 12.09); near(position(jittered, upper.id)[1], 16);
  sameContract(before, jittered);
  const repeated = await sketch.drag(upper, [12.091, 16]);
  for (const e of jittered.entities.filter(e => e.geometry.type === "point")) {
    near(position(repeated, e.reference.id)[0], position(jittered, e.reference.id)[0]);
    near(position(repeated, e.reference.id)[1], position(jittered, e.reference.id)[1]);
  }
  sameContract(jittered, repeated);
});

test("dragging the lower endpoint of a spaced vertical line preserves the upper endpoint", async t => {
  const { scene } = await startCore(t, "drag-spaced-vertical-lower");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const construction = await sketch.primitives.add("line", { from: [0, -10], to: [0, 10], construction: true });
  await sketch.constraints.add("vertical", { curves: construction.curves });
  await sketch.constraints.add("pointOnCurve", { points: [sketch.origin], curves: construction.curves });
  const line = await sketch.primitives.add("line", { from: [12.09, -15], to: [12.09, 8] });
  await sketch.constraints.add("vertical", { curves: line.curves });
  await sketch.dimensions.add("distance", { curves: [construction.curves[0]!, line.curves[0]!], value: 12.09, mode: "driving" });
  const before = await sketch.state(), lower = line.points[0]!;
  assert.equal(before.status.entities.find(e => e.entity.id === lower.id)!.degreesOfFreedom, 1);
  const after = await sketch.drag(lower, [10, -20]);
  near(position(after, lower.id)[0], 12.09); near(position(after, lower.id)[1], -20);
  sameContract(before, after);
  for (const e of before.entities.filter(e => e.reference.id !== lower.id)) {
    const actual = after.entities.find(a => a.reference.id === e.reference.id)!;
    assert.deepEqual({ ...actual, geometry: e.geometry }, e);
    if (e.geometry.type === "point") {
      near(position(after, e.reference.id)[0], e.geometry.position[0]);
      near(position(after, e.reference.id)[1], e.geometry.position[1]);
    } else assert.deepEqual(actual.geometry, e.geometry);
  }
  const repeated = await sketch.drag(lower, [10, -20]);
  for (const e of after.entities.filter(e => e.geometry.type === "point")) {
    near(position(repeated, e.reference.id)[0], position(after, e.reference.id)[0]);
    near(position(repeated, e.reference.id)[1], position(after, e.reference.id)[1]);
  }
  sameContract(after, repeated);
});

test("a degenerate rectangle drag fails without changing the working sketch", async t => {
  const { scene } = await startCore(t, "drag-invalid-geometry");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [-15, 15], to: [15, -15] });
  // Fix the opposite corner so coinciding both corners would collapse the profile.
  const fixed = pointsAt(await sketch.state(), -15, 15)[0]!;
  await sketch.constraints.add("fix", { points: [fixed] });
  const before = await sketch.state();
  await assert.rejects(sketch.drag(pointsAt(before, 15, -15)[0]!, [-15, 15]));
  assert.deepEqual(await sketch.state(), before);
});

test("manual recompute keeps drag edits unsolved until recompute", async t => {
  const { scene } = await startCore(t, "drag-manual-recompute");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [-15, 15], to: [15, -15] });
  const endpoints = pointsAt(await sketch.state(), 15, -15);
  await sketch.settings({ autoRecompute: false });
  const after = await sketch.drag(endpoints[0]!, [20, -20]);
  assert.deepEqual(position(after, endpoints[0]!.id), [20, -20]);
  assert.deepEqual(position(after, endpoints[1]!.id), [15, -15]);
  assert.equal(after.status.state, "stale");
  await sketch.recompute();
  const solved = await sketch.state();
  near(position(solved, endpoints[0]!.id)[0], position(solved, endpoints[1]!.id)[0]);
  near(position(solved, endpoints[0]!.id)[1], position(solved, endpoints[1]!.id)[1]);
});

test("dragging a horizontal rectangle edge moves both corners and preserves the opposite edge", async t => {
  const { scene, core } = await startCore(t, "drag-horizontal-edge");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [-15, 15], to: [15, -15] });
  const before = await sketch.state(), edge = edgeAt(before, 1, 15);
  const after = await sketch.drag(edge.reference, { from: [edge.from[0], 20], to: [edge.to[0], 20] });
  assert.equal(pointsAt(after, -15, 20).length, 2);
  assert.equal(pointsAt(after, 15, 20).length, 2);
  assert.equal(pointsAt(after, -15, -15).length, 2);
  assert.equal(pointsAt(after, 15, -15).length, 2);
  sameContract(before, after);
  await sketch.complete();
  const result = await core.solid.extrude(await sketch.regions.only(), { length1: 2 });
  near((await (await scene.bodies.get(result.newSolids[0]!.id)).properties()).volume.value, 2100);
});

test("dragging a vertical rectangle edge preserves the opposite edge", async t => {
  const { scene } = await startCore(t, "drag-vertical-edge");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [-15, 15], to: [15, -15] });
  const before = await sketch.state(), edge = edgeAt(before, 0, 15);
  const after = await sketch.drag(edge.reference, { from: [20, edge.from[1]], to: [20, edge.to[1]] });
  assert.equal(pointsAt(after, 20, 15).length, 2);
  assert.equal(pointsAt(after, 20, -15).length, 2);
  assert.equal(pointsAt(after, -15, 15).length, 2);
  assert.equal(pointsAt(after, -15, -15).length, 2);
  sameContract(before, after);
});

test("line drag targets are absolute and leave unrelated geometry unchanged", async t => {
  const { scene } = await startCore(t, "drag-free-line");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [2, 3], to: [12, 8] });
  const unrelated = (await sketch.primitives.add("point", { position: [-20, 20] })).points[0]!;
  const before = await sketch.state();
  const targets = { from: [7, 10] as [number, number], to: [17, 15] as [number, number] };
  const after = await sketch.drag(line.curves[0]!, targets);
  assert.equal(pointsAt(after, 7, 10).length, 1);
  assert.equal(pointsAt(after, 17, 15).length, 1);
  assert.deepEqual(position(after, unrelated.id), [-20, 20]);
  sameContract(before, after);
  const repeated = await sketch.drag(line.curves[0]!, targets);
  assert.deepEqual(repeated.entities, after.entities);
  sameContract(after, repeated);
});

test("line dragging honors a fixed endpoint and driving length in one solve", async t => {
  const { scene } = await startCore(t, "drag-constrained-line");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const start = pointsAt(await sketch.state(), 0, 0).find(p => p.id !== "origin")!;
  await sketch.constraints.add("fix", { points: [start] });
  await sketch.dimensions.add("length", { line: line.curves[0]!, value: 10, mode: "driving" });
  const before = await sketch.state();
  const target = { from: [5, 5] as [number, number], to: [15, 5] as [number, number] };
  const after = await sketch.drag(line.curves[0]!, target);
  assert.deepEqual(position(after, start.id), [0, 0]);
  const end = line.points.find(p => p.id !== start.id)!;
  near(position(after, end.id)[0], 30 / Math.sqrt(10), 1e-6);
  near(position(after, end.id)[1], 10 / Math.sqrt(10), 1e-6);
  assert.equal(after.status.degreesOfFreedom, before.status.degreesOfFreedom);
  assert.deepEqual(after.constraints, before.constraints);
  near(after.dimensions[0]!.computed.value, 10);
  const repeated = await sketch.drag(line.curves[0]!, target);
  near(position(repeated, end.id)[0], position(after, end.id)[0]);
  near(position(repeated, end.id)[1], position(after, end.id)[1]);
});

test("dragging a fixed line leaves its geometry and constraints unchanged", async t => {
  const { scene } = await startCore(t, "drag-fixed-line");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [2, 3], to: [12, 8] });
  await sketch.constraints.add("fix", { curves: line.curves });
  const before = await sketch.state();
  const after = await sketch.drag(line.curves[0]!, { from: [7, 10], to: [17, 15] });
  assert.deepEqual(after.entities, before.entities);
  sameContract(before, after);
});

test("a collapsed edge drag and a non-line target fail atomically", async t => {
  const { scene } = await startCore(t, "drag-invalid-edge");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [-15, 15], to: [15, -15] });
  const bottom = edgeAt(await sketch.state(), 1, -15);
  await sketch.constraints.add("fix", { curves: [bottom.reference] });
  const before = await sketch.state(), top = edgeAt(before, 1, 15);
  await assert.rejects(sketch.drag(top.reference, { from: [top.from[0], -15], to: [top.to[0], -15] }));
  assert.deepEqual(await sketch.state(), before);
  await assert.rejects(sketch.drag(pointsAt(before, -15, 15)[0]!, { from: [0, 0], to: [10, 10] }), /Select a line/);
  assert.deepEqual(await sketch.state(), before);
});

test("manual recompute updates both line endpoints without solving their coincidences", async t => {
  const { scene } = await startCore(t, "drag-manual-line");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [-15, 15], to: [15, -15] });
  const edge = edgeAt(await sketch.state(), 1, 15);
  await sketch.settings({ autoRecompute: false });
  const after = await sketch.drag(edge.reference, { from: [edge.from[0], 20], to: [edge.to[0], 20] });
  assert.equal(pointsAt(after, -15, 20).length, 1);
  assert.equal(pointsAt(after, 15, 20).length, 1);
  assert.equal(pointsAt(after, -15, 15).length, 1);
  assert.equal(pointsAt(after, 15, 15).length, 1);
  assert.equal(after.status.state, "stale");
  await sketch.recompute();
  assert.notEqual((await sketch.state()).status.state, "stale");
});

function splineTargets(state: SketchState, id: string, delta: [number, number]) {
  const g = state.entities.find(e => e.reference.id === id)!.geometry;
  assert.equal(g.type, "spline");
  if (g.type !== "spline") throw new Error("Expected spline");
  const ids = new Set(g.points);
  for (const node of state.splines.find(s => s.curve.id === id)?.fitPoints ?? []) {
    if (node.incoming) ids.add(node.incoming.id);
    if (node.outgoing) ids.add(node.outgoing.id);
  }
  return { points: [...ids].map(id => ({ point: state.entities.find(e => e.reference.id === id)!.reference,
    position: position(state, id).map((n, axis) => n + delta[axis]!) as [number, number] })) };
}

for (const fit of [false, true]) {
  const kind = fit ? "fit" : "control";
  test(`whole ${kind} spline drag translates its exact curve and handles with repeatable targets`, async t => {
    const { scene } = await startCore(t, `drag-${kind}-spline`);
    const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const curve = await s.primitives.add("spline", { points: [[-6, 1], [-2, 8], [5, -5], [10, 2]], fit });
    if (fit) await s.splines.setHandleMode((await s.state()).splines[0]!.fitPoints[1]!.point, "independent");
    const unrelated = await s.primitives.add("line", { from: [30, 30], to: [40, 35] });
    const before = await s.state(), proxy = await s.getProxy({ regions: false }), targets = splineTargets(before, curve.id, [7, -3]);
    const after = await s.drag(curve.curves[0]!, targets);
    sameContract(before, after); assert.deepEqual(after.splines, before.splines);
    assert.deepEqual(after.entities.filter(e => e.geometry.type !== "point"), before.entities.filter(e => e.geometry.type !== "point"));
    for (const target of targets.points) { near(position(after, target.point.id)[0], target.position[0]); near(position(after, target.point.id)[1], target.position[1]); }
    for (const ref of unrelated.points) assert.deepEqual(position(after, ref.id), position(before, ref.id));
    const samples = (await s.getProxy({ regions: false })).curves.find(c => c.entity.id === curve.id)!.points;
    const oldSamples = proxy.curves.find(c => c.entity.id === curve.id)!.points;
    assert.equal(samples.length, oldSamples.length);
    samples.forEach((p, i) => { near(p[0], oldSamples[i]![0] + 7); near(p[1], oldSamples[i]![1] - 3); near(p[2], oldSamples[i]![2]); });
    const repeated = await s.drag(curve.curves[0]!, { points: [...targets.points].reverse() });
    assert.deepEqual(repeated.entities, after.entities); sameContract(after, repeated);
  });

  test(`closed ${kind} spline drag preserves closure, extrusion and Finish/reopen`, async t => {
    const { core, scene } = await startCore(t, `drag-closed-${kind}`);
    const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const curve = await s.primitives.add("spline", { points: [[0, 0], [20, 0], [20, 15], [0, 15]], fit, closed: true });
    await s.complete();
    const feature = await core.solid.extrude(await s.regions.only(), { length1: 3 });
    const body = await scene.bodies.get(feature.newSolids[0]!.id), volume = (await body.properties()).volume.value;
    await s.edit(); const before = await s.state(), targets = splineTargets(before, curve.id, [12, -7]);
    const after = await s.drag(curve.curves[0]!, targets); sameContract(before, after);
    assert.deepEqual(after.splines, before.splines);
    assert.deepEqual((await s.drag(curve.curves[0]!, targets)).entities, after.entities);
    assert.equal((await s.getProxy()).regions.length, 1);
    await s.complete(); near((await body.properties()).volume.value, volume);
    await s.edit(); assert.deepEqual((await s.state()).entities, after.entities);
  });

  test(`whole ${kind} spline drag honors fixed nodes and retains unrelated geometry`, async t => {
    const { scene } = await startCore(t, `drag-fixed-node-${kind}`);
    const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const curve = await s.primitives.add("spline", { points: [[0, 0], [10, 8], [20, 0]], fit });
    const unrelated = await s.primitives.add("point", { position: [40, 40] });
    await s.constraints.add("fix", { points: [curve.points[0]!] });
    if (fit) {
      const state = await s.state(), node = state.splines[0]!.fitPoints[1]!;
      const tip = position(state, node.incoming!.id), center = position(state, node.point.id);
      await s.dimensions.add("distance", { points: [node.point, node.incoming!], value: Math.hypot(tip[0] - center[0], tip[1] - center[1]), mode: "driving" });
    }
    const before = await s.state(), targets = splineTargets(before, curve.id, [2, 3]);
    const after = await s.drag(curve.curves[0]!, targets);
    assert.deepEqual(position(after, curve.points[0]!.id), [0, 0]);
    assert.deepEqual(position(after, unrelated.points[0]!.id), [40, 40]);
    assert.deepEqual(after.constraints, before.constraints); assert.deepEqual(after.splines, before.splines);
    assert.equal(after.status.degreesOfFreedom, before.status.degreesOfFreedom);
    after.dimensions.forEach((d, i) => near(d.computed.value, before.dimensions[i]!.computed.value));
    assert.ok(position(after, curve.points[1]!.id)[1] > 8);
    const repeated = await s.drag(curve.curves[0]!, targets);
    for (const p of targets.points) { near(position(repeated, p.point.id)[0], position(after, p.point.id)[0], 1e-6); near(position(repeated, p.point.id)[1], position(after, p.point.id)[1], 1e-6); }
  });

  test(`fixed ${kind} spline drag stays fixed and manual drag applies every absolute target`, async t => {
    const { scene } = await startCore(t, `drag-manual-${kind}`);
    const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const curve = await s.primitives.add("spline", { points: [[0, 0], [10, 8], [20, 0]], fit });
    const points = splineTargets(await s.state(), curve.id, [0, 0]).points.map(p => p.point);
    await s.constraints.add("fix", { points });
    const before = await s.state(), targets = splineTargets(before, curve.id, [4, 6]);
    const fixed = await s.drag(curve.curves[0]!, targets); assert.deepEqual(fixed.entities, before.entities); sameContract(before, fixed);
    await s.settings({ autoRecompute: false });
    const manual = await s.drag(curve.curves[0]!, targets);
    assert.equal(manual.status.state, "stale");
    for (const target of targets.points) assert.deepEqual(position(manual, target.point.id), target.position);
    assert.deepEqual(manual.constraints, before.constraints); assert.deepEqual(manual.splines, before.splines);
    assert.deepEqual((await s.drag(curve.curves[0]!, targets)).entities, manual.entities);
  });
}

test("whole spline drag retains shared endpoints and connected curve identities", async t => {
  const { scene } = await startCore(t, "drag-joined-splines");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await s.primitives.add("spline", { points: [[0, 0], [10, 8], [20, 0]], fit: true });
  const b = await s.primitives.add("spline", { points: [[20, 0], [30, 0], [40, 0]] });
  await s.splines.join({ from: a.points[2]!, to: b.points[0]! });
  const before = await s.state(), targets = splineTargets(before, a.id, [2, 3]);
  const after = await s.drag(a.curves[0]!, targets);
  assert.deepEqual(after.splines, before.splines); assert.deepEqual(after.constraints, before.constraints);
  assert.deepEqual(position(after, b.points[0]!.id), [22, 3]);
  for (const ref of b.points.slice(1)) assert.deepEqual(position(after, ref.id), position(before, ref.id));
  assert.equal(after.entities.find(e => e.reference.id === a.id)!.geometry.type, "spline");
  assert.deepEqual((await s.drag(a.curves[0]!, targets)).entities, after.entities);
});

test("whole spline drag rejects incomplete, duplicate, foreign and nonfinite targets atomically", async t => {
  const { scene } = await startCore(t, "drag-spline-invalid");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const curve = await s.primitives.add("spline", { points: [[0, 0], [10, 8], [20, 0]], fit: true });
  const line = await s.primitives.add("line", { from: [40, 40], to: [50, 40] });
  const other = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const foreign = (await other.primitives.add("point", { position: [4, 5] })).points[0]!;
  const before = await s.state(), targets = splineTargets(before, curve.id, [2, 3]);
  for (const points of [targets.points.slice(1), [...targets.points, targets.points[0]!],
    targets.points.map((p, i) => i ? p : { ...p, point: foreign }),
    targets.points.map((p, i) => i ? p : { ...p, point: line.points[0]! }),
    targets.points.map((p, i) => i ? p : { ...p, point: curve.curves[0]! }),
    targets.points.map((p, i) => i ? p : { ...p, position: [NaN, 0] as [number, number] })]) {
    await assert.rejects(s.drag(curve.curves[0]!, { points })); assert.deepEqual(await s.state(), before);
  }
  await assert.rejects(s.drag(line.curves[0]!, targets), /Select a spline/); assert.deepEqual(await s.state(), before);
});

test("projected spline curves reject whole-curve dragging without mutation", async t => {
  const { core, scene } = await startCore(t, "drag-spline-projected");
  const base = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await base.primitives.add("spline", { points: [[0, 0], [20, 0], [20, 15], [0, 15]], fit: true, closed: true });
  await base.complete(); const profile = await base.regions.only();
  const feature = await core.solid.extrude(profile, { length1: 3 });
  const face = await feature.faces.endCap1({ profile }).only();
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await s.projections.add({ type: "face", reference: face });
  const before = await s.state(), spline = before.entities.find(e => e.projected && e.geometry.type === "spline");
  assert.ok(spline);
  await assert.rejects(s.drag(spline.reference, splineTargets(before, spline.reference.id, [2, 3])), /read-only/);
  assert.deepEqual(await s.state(), before);
});

test("native CLI host replays saved whole-spline drag commands and exact extrusion", { skip: process.env.PAMATCAD_TEST_RUNTIME === "wasm" }, async t => {
  const commands: { jsonrpc: "2.0"; id: number; method: Method; params: Parameters<Method> }[] = [];
  const responses: unknown[] = [];
  const { url } = await startCore(t, "spline-drag-replay");
  const transport = await WebSocketTransport.connect(url); t.after(() => transport.close());
  const recording: Transport = { async request(method, params) {
    commands.push(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: commands.length + 1, method, params })));
    const response = await transport.request(method, params); responses.push(response); return response;
  }, close() { transport.close(); } };
  const core = new Core(recording), scene = await core.scene.create("Spline drag");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  for (const [fit, dx] of [[true, 0], [false, 30]] as const) {
    const curve = await s.primitives.add("spline", { points: [[dx, 0], [dx + 20, 0], [dx + 20, 15], [dx, 15]], fit, closed: true });
    const targets = splineTargets(await s.state(), curve.id, [2, 3]);
    const after = await s.drag(curve.curves[0]!, targets);
    assert.deepEqual((await s.drag(curve.curves[0]!, targets)).entities, after.entities);
  }
  await s.complete();
  const regions = await s.regions.all(); assert.equal(regions.length, 2);
  for (const profile of regions) {
    const result = await core.solid.extrude(profile, { length1: 3 });
    assert.ok((await (await scene.bodies.get(result.newSolids[0]!.id)).properties()).volume.value > 0);
  }
  const directory = await mkdtemp(join(tmpdir(), "pamatcad-spline-drag-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "spline-drag.jsonl");
  await writeFile(file, commands.map(command => JSON.stringify(command)).join("\n"));
  const replay = await startCore(t, "spline-drag-replay"), replayTransport = await WebSocketTransport.connect(replay.url);
  t.after(() => replayTransport.close());
  const actual = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const command = JSON.parse(line) as typeof commands[number];
    actual.push(await replayTransport.request(command.method, command.params));
  }
  assert.deepEqual(actual, responses);
});
