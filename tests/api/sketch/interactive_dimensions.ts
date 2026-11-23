import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";

test("circle rim drag resizes first and preserves unrelated geometry and DOF", async t => {
  const { core, scene } = await startCore(t, "circle-rim");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [10, 20], diameter: 10 });
  const other = await sketch.primitives.add("point", { position: [30, 40] });
  const before = await sketch.state();
  await sketch.drag(circle.curves[0]!, { position: [16, 28] });
  const after = await sketch.state();
  assert.deepEqual(after.constraints, before.constraints);
  assert.deepEqual(after.status, before.status);
  assert.deepEqual(after.entities.filter(e => e.reference.id !== circle.curves[0]!.id), before.entities.filter(e => e.reference.id !== circle.curves[0]!.id));
  const geometry = after.entities.find(e => e.reference.id === circle.curves[0]!.id)!.geometry;
  assert.equal(geometry.type, "circle"); if (geometry.type === "circle") near(geometry.radius, 10);
  await sketch.drag(circle.curves[0]!, { position: [16, 28] });
  assert.deepEqual((await sketch.state()).entities, after.entities);
  await assert.rejects(sketch.drag(circle.curves[0]!, { position: [10, 20] }), /positive|drag|converge/);
  assert.deepEqual((await sketch.state()).entities, after.entities);
  await sketch.remove([other.points[0]!.id]);
  await sketch.complete();
  const feature = await core.solid.extrude(await sketch.regions.only(), { length1: 2 });
  near((await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value, Math.PI * 200);
});

test("a driving radius makes circle rim dragging move its center", async t => {
  const { scene } = await startCore(t, "circle-radius-drag");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [0, 0], diameter: 10 });
  await sketch.dimensions.add("radius", { curve: circle.curves[0]!, mode: "driving", value: 5 });
  await sketch.drag(circle.curves[0]!, { position: [12, 0] });
  const state = await sketch.state(), center = state.entities.find(e => e.reference.id === circle.points[0]!.id)!.geometry;
  assert.equal(center.type, "point"); if (center.type === "point") { near(center.position[0], 7); near(center.position[1], 0); }
  near(state.dimensions[0]!.computed.value, 5); assert.equal(state.status.degreesOfFreedom, 2);
});

test("fixed-center circles resize", async t => {
  const { scene } = await startCore(t, "circle-fixed-drag");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [2, 3], diameter: 10 });
  await sketch.constraints.add("fix", { points: [circle.points[0]!] });
  await sketch.drag(circle.curves[0]!, { position: [2, 10] });
  const radius = (await sketch.state()).entities.find(e => e.reference.id === circle.curves[0]!.id)!.geometry;
  if (radius.type === "circle") near(radius.radius, 7); else assert.fail("Expected circle");
});

test("fully fixed circles remain fixed during rim dragging", async t => {
  const { scene } = await startCore(t, "circle-fully-fixed-drag");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [2, 3], diameter: 14 });
  await sketch.constraints.add("fix", { curves: [circle.curves[0]!] });
  const before = await sketch.state();
  await sketch.drag(circle.curves[0]!, { position: [15, 20] });
  assert.deepEqual((await sketch.state()).entities, before.entities);
  assert.equal((await sketch.state()).status.degreesOfFreedom, 0);
});

test("manual circle rim dragging leaves a stale radius edit", async t => {
  const { scene } = await startCore(t, "circle-manual-drag");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [2, 3], diameter: 10 });
  await sketch.settings({ autoRecompute: false });
  await sketch.drag(circle.curves[0]!, { position: [2, 11] });
  const state = await sketch.state(), radius = state.entities.find(e => e.reference.id === circle.curves[0]!.id)!.geometry;
  assert.equal(state.status.state, "stale"); if (radius.type === "circle") near(radius.radius, 8); else assert.fail("Expected circle");
});

test("point-line distances measure the perpendicular to the infinite line", async t => {
  const { scene } = await startCore(t, "point-line-dimension");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [10, 0], to: [0, 0] });
  await sketch.constraints.add("fix", { curves: line.curves });
  const point = (await sketch.primitives.add("point", { position: [20, -4] })).points[0]!;
  const dimension = await sketch.dimensions.add("distance", { line: line.curves[0]!, points: [point], value: 4, mode: "driving" });
  near(dimension.computed.value, 4);
  await sketch.dimensions.update(dimension.id, { value: "12 / 2" });
  const g = (await sketch.state()).entities.find(e => e.reference.id === point.id)!.geometry;
  if (g.type === "point") near(Math.abs(g.position[1]), 6); else assert.fail("Expected point");
});

test("parallel-line distance owns parallelism and rejects nonparallel references", async t => {
  const { scene } = await startCore(t, "parallel-distance");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await sketch.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const b = await sketch.primitives.add("line", { from: [20, 5], to: [10, 5] });
  await sketch.constraints.add("fix", { curves: a.curves });
  const before = await sketch.state();
  const d = await sketch.dimensions.add("distance", { curves: [b.curves[0]!, a.curves[0]!], value: 5, mode: "driving" });
  assert.equal((await sketch.state()).status.degreesOfFreedom, before.status.degreesOfFreedom - 2);
  await sketch.dimensions.update(d.id, { value: "16 / 2" });
  const state = await sketch.state();
  const p = (id: string) => { const e = state.entities.find(e => e.reference.id === id)!.geometry; if (e.type !== "point") throw new Error("point"); return e.position; };
  near(p(b.points[0]!.id)[1], 8); near(p(b.points[1]!.id)[1], 8);
  await sketch.dimensions.remove(d.id);
  assert.equal((await sketch.state()).status.degreesOfFreedom, before.status.degreesOfFreedom);
  const c = await sketch.primitives.add("line", { from: [0, 0], to: [10, 10] });
  const stable = await sketch.state();
  await assert.rejects(sketch.dimensions.add("distance", { curves: [a.curves[0]!, c.curves[0]!], value: 2, mode: "driving" }), /parallel/);
  assert.deepEqual(await sketch.state(), stable);
  const angle = await sketch.dimensions.add("angle", { curves: [a.curves[0]!, c.curves[0]!], angleBranch: "supplementary", mode: "driven" });
  near(angle.computed.value, 135);
});

test("annotation placement is independent of solving and survives sketch lifecycle", async t => {
  const { scene } = await startCore(t, "dimension-annotation");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const d = await sketch.dimensions.add("length", { line: line.curves[0]!, value: 10, mode: "driving", annotation: { position: [5, 3] } });
  const before = await sketch.state(), proxy = await sketch.getProxy();
  await sketch.dimensions.update(d.id, { annotation: { position: [7, 6] } });
  const after = await sketch.state();
  assert.equal(after.revision, before.revision); assert.deepEqual(after.entities, before.entities); assert.deepEqual(after.status, before.status);
  assert.deepEqual(await sketch.getProxy(), proxy);
  await sketch.complete(); await sketch.edit();
  assert.deepEqual((await sketch.dimensions.get(d.id)).parameters.annotation, { position: [7, 6] });
  await sketch.dimensions.update(d.id, { annotation: { position: [8, 9] } });
  await sketch.cancel();
  assert.deepEqual((await sketch.dimensions.get(d.id)).parameters.annotation, { position: [7, 6] });
});

test("a reversed two-line angle drives its selected sector", async t => {
  const { scene } = await startCore(t, "reversed-angle");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await s.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const b = await s.primitives.add("line", { from: [0, 0], to: [10, -10] });
  await s.constraints.add("fix", { curves: a.curves });
  const d = await s.dimensions.add("angle", { curves: [a.curves[0]!, b.curves[0]!], angleBranch: "reversed", value: 45, mode: "driving" });
  await s.dimensions.update(d.id, { value: "60 deg", annotation: { position: [10, -3] } });
  near((await s.dimensions.get(d.id)).computed.value, 60);
  const before = await s.state();
  await s.dimensions.update(d.id, { annotation: { position: [-10, 3] } });
  assert.deepEqual((await s.state()).entities, before.entities);
  near((await s.dimensions.get(d.id)).computed.value, 60);
});

test("a supplementary two-line angle drives its selected sector", async t => {
  const { scene } = await startCore(t, "supplementary-angle");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await s.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const b = await s.primitives.add("line", { from: [0, 0], to: [10, 10] });
  await s.constraints.add("fix", { curves: a.curves });
  const d = await s.dimensions.add("angle", { curves: [a.curves[0]!, b.curves[0]!], angleBranch: "supplementary", value: 135, mode: "driving" });
  await s.dimensions.update(d.id, { value: 120 });
  near((await s.dimensions.get(d.id)).computed.value, 120);
  const direct = await s.dimensions.add("angle", { curves: [a.curves[0]!, b.curves[0]!], mode: "driven" });
  near(direct.computed.value, 60);
});

test("a reversed supplementary angle has the same measurement under reversed selection", async t => {
  const { scene } = await startCore(t, "reverse-supplementary-angle");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await s.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const b = await s.primitives.add("line", { from: [0, 0], to: [10, 10] });
  const d = await s.dimensions.add("angle", { curves: [b.curves[0]!, a.curves[0]!], angleBranch: "reversedSupplementary", value: 135, mode: "driving" });
  await s.dimensions.update(d.id, { value: 110 });
  near((await s.dimensions.get(d.id)).computed.value, 110);
  const direct = await s.dimensions.add("angle", { curves: [a.curves[0]!, b.curves[0]!], mode: "driven" });
  near(direct.computed.value, 70);
});

test("a driven parallel distance rejects a change outside its domain atomically", async t => {
  const { scene } = await startCore(t, "driven-parallel-distance");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await s.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const b = await s.primitives.add("line", { from: [0, 5], to: [10, 5] });
  const d = await s.dimensions.add("distance", { curves: [a.curves[0]!, b.curves[0]!], mode: "driven" });
  const before = await s.state();
  await assert.rejects(s.drag(b.points[1]!, [10, 8]), /parallel/);
  assert.deepEqual(await s.state(), before);
  await s.dimensions.remove(d.id);
  await s.drag(b.points[1]!, [10, 8]);
});

test("annotation positions follow full-geometry transforms and copies", async t => {
  const { scene } = await startCore(t, "annotation-transform");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await s.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const d = await s.dimensions.add("length", { line: line.curves[0]!, mode: "driven", annotation: { position: [5, 3] } });
  await s.transform({ entities: line.curves, translation: [10, 20], angle: 90, pivot: [0, 0] });
  const transformed = await s.dimensions.get(d.id);
  near(transformed.parameters.annotation!.position[0], 7); near(transformed.parameters.annotation!.position[1], 25);
  await s.transform({ entities: line.curves, translation: [20, 0], pivot: [0, 0], copy: true });
  const dimensions = (await s.state()).dimensions;
  assert.equal(dimensions.length, 2);
  const copied = dimensions.find(candidate => candidate.id !== d.id)!;
  near(copied.parameters.annotation!.position[0], 27); near(copied.parameters.annotation!.position[1], 25);
  assert.deepEqual((await s.dimensions.get(d.id)).parameters.annotation, transformed.parameters.annotation);
});

test("projected circular boundaries reject rim dragging", async t => {
  const { core, scene } = await startCore(t, "projected-circle-rim");
  const base = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await base.primitives.add("circle", { center: [0, 0], diameter: 10 });
  await base.complete();
  const profile = await base.regions.only();
  const feature = await core.solid.extrude(profile, { length1: 10 });
  const face = await feature.faces.endCap1({ profile }).only();
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await s.projections.add({ type: "face", reference: face });
  const before = await s.state();
  // Projection currently represents conics as exact rational splines. The rim request
  // must still be rejected as read-only before the primitive-type check.
  const circle = before.entities.find(e => e.projected && e.geometry.type !== "point")!;
  assert.ok(circle);
  await assert.rejects(s.drag(circle.reference, { position: [12, 0] }), /read-only/);
  assert.deepEqual(await s.state(), before);
});

test("invalid circle targets and annotation coordinates fail atomically", async t => {
  const { scene } = await startCore(t, "invalid-circle-annotation");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await s.primitives.add("circle", { center: [0, 0], diameter: 10 });
  const d = await s.dimensions.add("radius", { curve: circle.curves[0]!, mode: "driven", annotation: { position: [5, 7] } });
  const before = await s.state();
  await assert.rejects(s.drag(circle.curves[0]!, { position: [Infinity, 0] }));
  await assert.rejects(s.dimensions.update(d.id, { annotation: { position: [0, NaN] } }));
  assert.deepEqual(await s.state(), before);
});

test("a point-line distance can increase from zero separation", async t => {
  const { scene } = await startCore(t, "zero-point-line-distance");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await s.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const point = (await s.primitives.add("point", { position: [5, 0] })).points[0]!;
  await s.constraints.add("fix", { curves: line.curves });
  const d = await s.dimensions.add("distance", { line: line.curves[0]!, points: [point], mode: "driving", value: 3 });
  near(d.computed.value, 3);
  await s.dimensions.update(d.id, { value: 0 });
  near((await s.dimensions.get(d.id)).computed.value, 0);
  await s.dimensions.update(d.id, { value: 5 });
  near((await s.dimensions.get(d.id)).computed.value, 5);
});

test("a parallel-line distance can separate collinear lines", async t => {
  const { scene } = await startCore(t, "zero-parallel-distance");
  const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await s.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const b = await s.primitives.add("line", { from: [20, 0], to: [30, 0] });
  await s.constraints.add("fix", { curves: a.curves });
  const d = await s.dimensions.add("distance", { curves: [a.curves[0]!, b.curves[0]!], mode: "driving", value: 4 });
  near(d.computed.value, 4);
  const state = await s.state();
  const first = state.entities.find(e => e.reference.id === b.points[0]!.id)!.geometry;
  const second = state.entities.find(e => e.reference.id === b.points[1]!.id)!.geometry;
  if (first.type === "point" && second.type === "point") near(first.position[1], second.position[1]); else assert.fail("Expected line endpoints");
});

test("arc rim resizing preserves center and angles and remains extrudable", async t => {
  const { core, scene } = await startCore(t, "arc-rim");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const arc = await sketch.primitives.add("arc", { center: [2, 3], radius: 5, start: 0, end: 180 });
  const other = await sketch.primitives.add("point", { position: [20, 20] });
  const before = await sketch.state();
  await sketch.drag(arc.curves[0]!, { position: [2, 11] });
  const after = await sketch.state(), g = after.entities.find(e => e.reference.id === arc.curves[0]!.id)!.geometry;
  if (g.type !== "arc") assert.fail("arc");
  near(g.radius, 8); near(g.start, 0); near(g.end, Math.PI);
  assert.deepEqual(after.entities.find(e => e.reference.id === g.center)!.geometry, { type: "point", position: [2, 3] });
  assert.deepEqual(after.entities.find(e => e.reference.id === other.points[0]!.id), before.entities.find(e => e.reference.id === other.points[0]!.id));
  assert.deepEqual(after.constraints, before.constraints); assert.deepEqual(after.status, before.status);
  assert.deepEqual(after.entities.map(e => e.reference.id), before.entities.map(e => e.reference.id));
  await sketch.drag(arc.curves[0]!, { position: [2, 11] });
  const repeated = await sketch.state();
  for (const point of arc.points) {
    const a = after.entities.find(e => e.reference.id === point.id)!.geometry, b = repeated.entities.find(e => e.reference.id === point.id)!.geometry;
    if (a.type !== "point" || b.type !== "point") assert.fail("point");
    near(a.position[0], b.position[0]); near(a.position[1], b.position[1]);
  }
  await assert.rejects(sketch.drag(arc.curves[0]!, { position: [2, 3] }), /positive|drag|converge/);
  assert.deepEqual(await sketch.state(), repeated);
  await sketch.primitives.add("line", { from: [-6, 3], to: [10, 3] });
  await sketch.complete();
  const feature = await core.solid.extrude(await sketch.regions.only(), { length1: 2 });
  near((await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value, Math.PI * 64);
});

test("arc center dragging translates its endpoints while retaining radius and sweep", async t => {
  const { scene } = await startCore(t, "arc-center");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const arc = await sketch.primitives.add("arc", { center: [2, 3], radius: 5, start: 30, end: 150 });
  const before = await sketch.state();
  await sketch.drag(arc.points[0]!, [-2, 7]);
  const after = await sketch.state(), g = after.entities.find(e => e.reference.id === arc.curves[0]!.id)!.geometry;
  if (g.type !== "arc") assert.fail("arc");
  near(g.radius, 5); near(g.start, Math.PI / 6); near(g.end, 5 * Math.PI / 6);
  for (const point of arc.points) {
    const a = before.entities.find(e => e.reference.id === point.id)!.geometry, b = after.entities.find(e => e.reference.id === point.id)!.geometry;
    if (a.type !== "point" || b.type !== "point") assert.fail("point");
    near(b.position[0], a.position[0] - 4); near(b.position[1], a.position[1] + 4);
  }
  assert.deepEqual(after.constraints, before.constraints); assert.deepEqual(after.status, before.status);
});

test("fixed arc centers permit rim resizing", async t => {
  const { scene } = await startCore(t, "arc-fixed-center");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const arc = await sketch.primitives.add("arc", { center: [2, 3], radius: 5, start: -60, end: 60 });
  await sketch.constraints.add("fix", { points: [arc.points[0]!] });
  await sketch.drag(arc.curves[0]!, { position: [10, 3] });
  const state = await sketch.state(), g = state.entities.find(e => e.reference.id === arc.curves[0]!.id)!.geometry;
  if (g.type !== "arc") assert.fail("arc");
  near(g.radius, 8); near(g.start, -Math.PI / 3); near(g.end, Math.PI / 3);
  assert.deepEqual(state.entities.find(e => e.reference.id === arc.points[0]!.id)!.geometry, { type: "point", position: [2, 3] });
});

test("a driving arc radius takes priority over center preservation", async t => {
  const { scene } = await startCore(t, "arc-driven-radius");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const arc = await sketch.primitives.add("arc", { center: [0, 0], radius: 5, start: -60, end: 60 });
  await sketch.dimensions.add("radius", { curve: arc.curves[0]!, value: 5, mode: "driving" });
  await sketch.drag(arc.curves[0]!, { position: [9, 0] });
  const state = await sketch.state(), g = state.entities.find(e => e.reference.id === arc.curves[0]!.id)!.geometry;
  if (g.type !== "arc") assert.fail("arc");
  near(g.radius, 5);
  const center = state.entities.find(e => e.reference.id === g.center)!.geometry;
  if (center.type !== "point") assert.fail("center");
  near(Math.hypot(9 - center.position[0], center.position[1]), 5);
  assert.ok(Math.hypot(...center.position) > 1);
});

test("fully fixed arcs remain fixed during rim and center dragging", async t => {
  const { scene } = await startCore(t, "arc-fixed");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const arc = await sketch.primitives.add("arc", { center: [2, 3], radius: 5, start: 0, end: 180 });
  await sketch.constraints.add("fix", { curves: arc.curves });
  const before = await sketch.state();
  await sketch.drag(arc.curves[0]!, { position: [15, 15] });
  assert.deepEqual((await sketch.state()).entities, before.entities);
  await sketch.drag(arc.points[0]!, [20, 20]);
  assert.deepEqual((await sketch.state()).entities, before.entities);
});

test("manual arc rim and center edits update endpoints coherently", async t => {
  const { scene } = await startCore(t, "arc-manual");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const arc = await sketch.primitives.add("arc", { center: [2, 3], radius: 5, start: 0, end: 180 });
  await sketch.settings({ autoRecompute: false });
  await sketch.drag(arc.curves[0]!, { position: [2, 11] });
  await sketch.drag(arc.points[0]!, [4, 6]);
  const state = await sketch.state();
  assert.equal(state.status.state, "stale");
  const point = (id: string) => { const g = state.entities.find(e => e.reference.id === id)!.geometry; if (g.type !== "point") throw new Error("point"); return g.position; };
  near(point(arc.points[1]!.id)[0], 12); near(point(arc.points[1]!.id)[1], 6);
  near(point(arc.points[2]!.id)[0], -4); near(point(arc.points[2]!.id)[1], 6);
  await sketch.recompute();
  assert.notEqual((await sketch.state()).status.state, "stale");
});

test("projected arc edges reject dragging without changing the sketch", async t => {
  const { core, scene } = await startCore(t, "arc-projected");
  const base = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await base.primitives.add("arc", { center: [0, 0], radius: 10, start: 0, end: 180 });
  await base.primitives.add("line", { from: [-10, 0], to: [10, 0] });
  await base.complete();
  const profile = await base.regions.only(), feature = await core.solid.extrude(profile, { length1: 2 });
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.projections.add({ type: "face", reference: await feature.faces.endCap1({ profile }).only() });
  const before = await sketch.state();
  // The projection bridge preserves the trimmed circular boundary as an exact spline.
  const arc = before.entities.find(e => e.projected && e.geometry.type === "spline")!;
  assert.ok(arc);
  await assert.rejects(sketch.drag(arc.reference, { position: [0, 20] }), /read-only/);
  assert.deepEqual(await sketch.state(), before);
});

test("legacy circle drag requests remain supported", async t => {
  const { scene } = await startCore(t, "legacy-circle-drag");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [0, 0], diameter: 10 });
  // Exercise the legacy wire shape through the same SDK transport in both runtimes.
  const transport = (sketch as unknown as { transport: import("@pamatcad/sdk").Transport }).transport;
  const state = await transport.request("sketch.drag", { sketch: { id: sketch.id, sceneId: scene.id }, circle: circle.curves[0]!, position: [10, 0] });
  const geometry = state.entities.find(e => e.reference.id === circle.curves[0]!.id)!.geometry;
  if (geometry.type !== "circle") assert.fail("circle");
  near(geometry.radius, 10);
});
