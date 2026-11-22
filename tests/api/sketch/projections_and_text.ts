import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { startCore } from "../../support/core.js";
import { near, rectangle } from "../../support/extrude.js";
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
