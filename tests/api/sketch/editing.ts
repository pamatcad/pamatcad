import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";
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
