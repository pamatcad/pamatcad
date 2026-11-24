import assert from "node:assert/strict";
import { test } from "node:test";
import type { GeometryData, SketchEntityRef, SketchState } from "@pamatcad/sdk";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";

function point(state: SketchState, ref: SketchEntityRef) {
  const geometry = state.entities.find(e => e.reference.id === ref.id)!.geometry;
  assert.equal(geometry.type, "point");
  if (geometry.type !== "point") throw new Error("Expected point");
  return geometry.position;
}

function radius(state: SketchState, ref: SketchEntityRef) {
  const geometry = state.entities.find(e => e.reference.id === ref.id)!.geometry;
  assert.equal(geometry.type, "circle");
  if (geometry.type !== "circle") throw new Error("Expected circle");
  return geometry.radius;
}

test("dragging one of 100 independent slots preserves the other 99 and their freedom", async t => {
  const { scene } = await startCore(t, "independent-slot-components");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.settings({ autoRecompute: false });
  const slots: GeometryData[] = [];
  for (let i = 0; i < 100; i++) {
    const x = (i % 10) * 20, y = Math.floor(i / 10) * 12;
    slots.push(await sketch.primitives.add("slot", { from: [x, y], to: [x + 8, y], radius: 2 }));
  }
  await sketch.settings({ autoRecompute: true });
  const before = await sketch.state();
  const changed = new Set([...slots[0]!.points, ...slots[0]!.curves].map(r => r.id));
  const target = slots[0]!.points.at(-1)!;
  const after = await sketch.drag(target, [5, 0.5]);
  near(point(after, target)[0], 5); near(point(after, target)[1], 0.5);
  assert.deepEqual(after.entities.filter(e => !changed.has(e.reference.id)), before.entities.filter(e => !changed.has(e.reference.id)));
  assert.deepEqual(after.constraints, before.constraints);
  assert.deepEqual(after.status, before.status);
  assert.equal(after.status.degreesOfFreedom, 500);
  const repeated = await sketch.drag(target, [5, 0.5]);
  assert.deepEqual(repeated.status, after.status);
  for (const ref of slots[0]!.points) {
    near(point(repeated, ref)[0], point(after, ref)[0]);
    near(point(repeated, ref)[1], point(after, ref)[1]);
  }
  assert.deepEqual(repeated.entities.filter(e => !changed.has(e.reference.id)), before.entities.filter(e => !changed.has(e.reference.id)));
  await sketch.complete();
  assert.equal((await sketch.regions.all()).length, 100);
});

test("free entities aggregate freedom across independent scalar components", async t => {
  const { scene } = await startCore(t, "free-component-freedom");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const circle = await sketch.primitives.add("circle", { center: [30, 0], diameter: 4 });
  const ellipse = await sketch.primitives.add("ellipse", { center: [50, 0], major: 5, minor: 2 });
  const before = await sketch.state();
  assert.equal(before.status.degreesOfFreedom, 12);
  assert.equal(before.status.entities.find(e => e.entity.id === line.curves[0]!.id)!.degreesOfFreedom, 4);
  assert.equal(before.status.entities.find(e => e.entity.id === circle.curves[0]!.id)!.degreesOfFreedom, 3);
  assert.equal(before.status.entities.find(e => e.entity.id === ellipse.curves[0]!.id)!.degreesOfFreedom, 5);
  const after = await sketch.drag(line.curves[0]!, { from: [2, 3], to: [12, 3] });
  assert.deepEqual(point(after, line.points[0]!), [2, 3]);
  assert.deepEqual(point(after, line.points[1]!), [12, 3]);
  const linePoints = new Set(line.points.map(r => r.id));
  assert.deepEqual(after.entities.filter(e => !linePoints.has(e.reference.id)), before.entities.filter(e => !linePoints.has(e.reference.id)));
  assert.deepEqual(after.status, before.status);
});

test("independent distances sharing the fixed origin retain constrained cursor fitting", async t => {
  const { scene } = await startCore(t, "fixed-origin-components");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = (await sketch.primitives.add("point", { position: [10, 0] })).points[0]!;
  const b = (await sketch.primitives.add("point", { position: [0, 20] })).points[0]!;
  await sketch.dimensions.add("distance", { points: [sketch.origin, a], value: 10, mode: "driving" });
  await sketch.dimensions.add("distance", { points: [sketch.origin, b], value: 20, mode: "driving" });
  const before = await sketch.state();
  const after = await sketch.drag(a, [10, 10]);
  near(point(after, a)[0], Math.sqrt(50)); near(point(after, a)[1], Math.sqrt(50));
  assert.deepEqual(point(after, b), point(before, b));
  assert.deepEqual(point(after, sketch.origin), [0, 0]);
  assert.equal(after.status.degreesOfFreedom, 2);
  assert.deepEqual(after.status, before.status);
});

test("adding and removing a radius equality joins and separates solver components", async t => {
  const { scene } = await startCore(t, "changing-component-connection");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await sketch.primitives.add("circle", { center: [0, 0], diameter: 10 });
  const b = await sketch.primitives.add("circle", { center: [50, 0], diameter: 10 });
  await sketch.constraints.add("fix", { points: [a.points[0]!, b.points[0]!] });
  const equal = await sketch.constraints.add("equal", { curves: [a.curves[0]!, b.curves[0]!] });
  let state = await sketch.drag(a.curves[0]!, { position: [6, 0] });
  near(radius(state, a.curves[0]!), 6); near(radius(state, b.curves[0]!), 6);
  assert.equal(state.status.degreesOfFreedom, 1);
  await sketch.constraints.remove(equal.id);
  state = await sketch.drag(a.curves[0]!, { position: [7, 0] });
  near(radius(state, a.curves[0]!), 7); near(radius(state, b.curves[0]!), 6);
  assert.equal(state.status.degreesOfFreedom, 2);
  await sketch.constraints.add("equal", { curves: [a.curves[0]!, b.curves[0]!] });
  state = await sketch.drag(b.curves[0]!, { position: [58, 0] });
  near(radius(state, a.curves[0]!), 8); near(radius(state, b.curves[0]!), 8);
  assert.equal(state.status.degreesOfFreedom, 1);
});

test("measurement formulas couple separate circles and preserve preview and extrusion results", async t => {
  const { core, scene } = await startCore(t, "formula-components");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await sketch.primitives.add("circle", { center: [0, 0], diameter: 10 });
  const b = await sketch.primitives.add("circle", { center: [50, 0], diameter: 20 });
  await sketch.constraints.add("fix", { points: [a.points[0]!, b.points[0]!] });
  await sketch.dimensions.add("radius", { curve: a.curves[0], name: "source", mode: "driven" });
  await sketch.dimensions.add("radius", { curve: b.curves[0], value: "source * 2", mode: "driving" });
  const state = await sketch.drag(a.curves[0]!, { position: [6, 0] });
  near(radius(state, a.curves[0]!), 6); near(radius(state, b.curves[0]!), 12);
  assert.equal(state.status.degreesOfFreedom, 1);
  await sketch.primitives.add("circle", { center: [90, 0], diameter: 4 }, { preview: true });
  assert.equal((await sketch.state({ preview: true })).status.degreesOfFreedom, 4);
  assert.deepEqual(await sketch.state(), state);
  await scene.discardPreview();
  await sketch.complete();
  const extrusion = await core.solid.extrude(await sketch.regions.all(), { length1: 2 });
  assert.equal(extrusion.newSolids.length, 2);
  const volumes = await Promise.all(extrusion.newSolids.map(async ref => (await (await scene.bodies.get(ref.id)).properties()).volume.value));
  near(volumes.reduce((a, b) => a + b, 0), Math.PI * 360);
  await sketch.edit(); await sketch.complete();
  assert.equal((await scene.bodies.all()).length, 2);
});

test("constant-only conflicting equations fail without publishing partial component results", async t => {
  const { scene } = await startCore(t, "constant-component-conflict");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = (await sketch.primitives.add("point", { position: [0, 0] })).points[0]!;
  const b = (await sketch.primitives.add("point", { position: [10, 0] })).points[0]!;
  await sketch.constraints.add("fix", { points: [a, b] });
  await sketch.primitives.add("circle", { center: [30, 0], diameter: 4 });
  const before = await sketch.state();
  await assert.rejects(sketch.constraints.add("coincident", { points: [a, b] }), /conflict|converge/);
  assert.deepEqual(await sketch.state(), before);
});

test("component reuse follows manual coordinate edits, fixed masks and unrelated additions", async t => {
  const { scene } = await startCore(t, "component-cache-invalidation");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [0, 0], to: [10, 0] });
  await sketch.constraints.add("horizontal", { curves: line.curves });
  const circle = await sketch.primitives.add("circle", { center: [30, 0], diameter: 4 });
  await sketch.recompute();
  const before = await sketch.state();
  await sketch.settings({ autoRecompute: false });
  await sketch.drag(line.points[1]!, [12, 3]);
  await sketch.getProxy();
  assert.equal((await sketch.state()).status.state, "stale");
  await sketch.recompute();
  let state = await sketch.state();
  near(point(state, line.points[0]!)[1], point(state, line.points[1]!)[1]);
  assert.equal(state.status.degreesOfFreedom, 6);
  assert.deepEqual(point(state, circle.points[0]!), point(before, circle.points[0]!));
  await sketch.settings({ autoRecompute: true });
  const fixed = await sketch.constraints.add("fix", { curves: line.curves });
  assert.equal((await sketch.state()).status.degreesOfFreedom, 3);
  await sketch.primitives.add("point", { position: [100, 100] });
  assert.equal((await sketch.state()).status.degreesOfFreedom, 5);
  await sketch.constraints.remove(fixed.id);
  state = await sketch.state();
  assert.equal(state.status.degreesOfFreedom, 8);
  assert.equal(state.status.entities.find(e => e.entity.id === line.curves[0]!.id)!.degreesOfFreedom, 3);
  assert.equal(state.status.entities.find(e => e.entity.id === circle.curves[0]!.id)!.degreesOfFreedom, 3);
});
