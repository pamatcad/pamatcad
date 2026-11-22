import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";
test("sketch regions include nested holes and preserve exact circular boundaries", async (t) => {
  const { core, scene } = await startCore(t, "sketch-holes");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [0, 0], to: [20, 20] });
  await sketch.primitives.add("circle", { center: [10, 10], diameter: 10 });
  await sketch.complete();
  const proxy = await sketch.getProxy();
  assert.equal(proxy.regions.length, 2);
  const annulus = proxy.regions.find(r => r.holes.length === 1)!;
  assert.ok(annulus);
  const feature = await core.solid.extrude(annulus.region, { length1: 10 });
  const body = await scene.bodies.get(feature.newSolids[0]!.id);
  near((await body.properties()).volume.value, (400 - Math.PI * 25) * 10);
});
test("a constrained slot extrudes exact semicircles and excludes its construction axis", async (t) => {
  const { core, scene } = await startCore(t, "slot-profile");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xz);
  await sketch.primitives.add("slot", { from: [0, 0], to: [20, 0], radius: 5 });
  await sketch.complete();
  const profile = await sketch.regions.only();
  const feature = await core.solid.extrude(profile, { length1: 10 });
  const body = await scene.bodies.get(feature.newSolids[0]!.id);
  near((await body.properties()).volume.value, (200 + Math.PI * 25) * 10);
  assert.equal((await feature.faces.sideFaces1({ profile }).all()).length, 4);
});
test("an ellipse creates an exact extrudable region", async (t) => {
  const { core, scene } = await startCore(t, "ellipse-profile");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.yz);
  await sketch.primitives.add("ellipse", { center: [0, 0], major: 10, minor: 5, angle: 30 });
  await sketch.complete();
  const feature = await core.solid.extrude(await sketch.regions.only(), { length1: 10 });
  const body = await scene.bodies.get(feature.newSolids[0]!.id);
  near((await body.properties()).volume.value, Math.PI * 500);
});
test("intersecting rectangles produce three bounded regions without altering their source lines", async (t) => {
  const { scene } = await startCore(t, "intersecting-profiles");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
  await sketch.primitives.add("rectangle", { from: [5, 5], to: [15, 15] });
  await sketch.complete();
  assert.equal((await sketch.regions.all()).length, 3);
  assert.equal((await sketch.state()).entities.filter(e => e.geometry.type === "line").length, 8);
});
