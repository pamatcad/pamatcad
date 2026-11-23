import assert from "node:assert/strict";
import { test } from "node:test";
import type { SketchState } from "@pamatcad/sdk";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";

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
