import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";

test("geometry-only proxies omit regions without changing curves, previews or final profiles", async t => {
  const { scene, core } = await startCore(t, "sketch-proxy-live");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  assert.equal((await sketch.getProxy({ regions: false })).regions, null);
  assert.deepEqual((await sketch.getProxy()).regions, []);
  const circle = await sketch.primitives.add("circle", { center: [0, 0], diameter: 10 });
  const geometry = await sketch.getProxy({ regions: false });
  const full = await sketch.getProxy();
  assert.deepEqual(geometry, { ...full, regions: null });
  await sketch.primitives.add("circle", { center: [20, 0], diameter: 4 }, { preview: true });
  const preview = await sketch.getProxy({ regions: false, preview: true });
  assert.deepEqual(preview, { ...await sketch.getProxy({ preview: true }), regions: null });
  assert.equal(preview.curves.length, 2);
  assert.deepEqual(await sketch.getProxy(), full);
  await scene.discardPreview();
  await assert.rejects(sketch.getProxy({ regions: false, preview: true }), /cached/);
  await sketch.drag(circle.curves[0]!, { position: [7, 0] });
  const dragged = await sketch.getProxy({ regions: false });
  assert.equal(dragged.regions, null);
  assert.notDeepEqual(dragged.curves, geometry.curves);
  await sketch.complete();
  assert.deepEqual(await sketch.getProxy({ regions: false }), { ...await sketch.getProxy({ regions: true }), regions: null });
  const feature = await core.solid.extrude(await sketch.regions.only(), { length1: 2 });
  near((await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value, Math.PI * 98);
});

test("cached sketch proxies follow coordinate and construction changes and preserve exact extrusion", async t => {
  const { scene, core } = await startCore(t, "sketch-proxy-geometry");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [0, 0], diameter: 10 });
  const initial = await sketch.getProxy();
  assert.deepEqual(await sketch.getProxy(), initial);
  await sketch.drag(circle.curves[0]!, { position: [7, 0] });
  const resized = await sketch.getProxy();
  assert.equal(resized.regions.length, 1);
  assert.ok(resized.curves[0]!.points.every(([x, y]) => Math.abs(Math.hypot(x, y) - 7) < 1e-6));
  assert.deepEqual(await sketch.getProxy(), resized);
  await sketch.construction(circle.curves, true);
  const construction = await sketch.getProxy();
  assert.equal(construction.regions.length, 0);
  assert.ok(construction.curves.every(c => c.construction));
  await sketch.construction(circle.curves, false);
  assert.deepEqual(await sketch.getProxy(), resized);
  await sketch.complete();
  const feature = await core.solid.extrude(await sketch.regions.only(), { length1: 2 });
  near((await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value, Math.PI * 98);
});

test("cached profiles and curve samples follow the sketch support frame", async t => {
  const { scene, core } = await startCore(t, "sketch-proxy-frame");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 5] });
  const before = await sketch.getProxy();
  await sketch.getProxy();
  await sketch.support.update(scene.construction.builtin.planes.xz);
  const after = await sketch.getProxy();
  for (const point of after.points) {
    const previous = before.points.find(p => p.entity.id === point.entity.id)!;
    assert.deepEqual(point.position, [previous.position[0], 0, previous.position[1]]);
  }
  assert.ok(after.regions[0]!.boundary.every(p => Math.abs(p[1]) < 1e-7));
  near(Math.max(...after.regions[0]!.boundary.map(p => p[2])), 5);
  assert.deepEqual(await sketch.getProxy(), after);
  await sketch.complete();
  const feature = await core.solid.extrude(await sketch.regions.only(), { length1: 2 });
  near((await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value, 100);
});

test("preview caches and cancelled edits cannot replace the working sketch proxy", async t => {
  const { scene } = await startCore(t, "sketch-proxy-isolation");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [0, 0], diameter: 10 });
  const before = await sketch.getProxy();
  await sketch.primitives.add("circle", { center: [20, 0], diameter: 4 }, { preview: true });
  const preview = await sketch.getProxy({ preview: true });
  assert.equal(preview.regions.length, 2);
  assert.deepEqual(await sketch.getProxy({ preview: true }), preview);
  assert.deepEqual(await sketch.getProxy(), before);
  await scene.discardPreview();
  await assert.rejects(sketch.getProxy({ preview: true }), /cached/);
  await sketch.complete(); await sketch.edit();
  await sketch.drag(circle.curves[0]!, { position: [8, 0] });
  assert.notDeepEqual(await sketch.getProxy(), before);
  await sketch.cancel();
  assert.deepEqual(await sketch.getProxy(), before);
});

test("batched text normalization preserves glyph holes and reference volumes", async t => {
  const { scene, core } = await startCore(t, "text-normalization-cells");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const text = await sketch.primitives.add("text", { text: "ffiB@", origin: [0, 0], size: 10 });
  const before = await sketch.getProxy();
  assert.equal(before.regions.length, 7);
  assert.deepEqual(before.regions.map(r => r.holes.length).sort(), [0, 0, 0, 0, 0, 1, 2]);
  assert.deepEqual(await sketch.getProxy(), before);
  await sketch.texts.update(text.id, { text: "O" }, { preview: true });
  const preview = await sketch.getProxy({ preview: true });
  assert.equal(preview.regions.length, 2);
  assert.deepEqual(await sketch.getProxy(), before);
  await scene.discardPreview();
  await sketch.complete();
  const feature = await core.solid.extrude(before.regions.filter(r => r.holes.length > 0).map(r => r.region), { length1: 1 });
  const volumes = await Promise.all(feature.newSolids.map(async ref => (await (await scene.bodies.get(ref.id)).properties()).volume.value));
  volumes.sort((a, b) => a - b);
  assert.equal(volumes.length, 2);
  near(volumes[0]!, 18.545449994418085); near(volumes[1]!, 24.097748312949527);
});

test("region caches preserve nested contours and ignore open wires", async t => {
  const { scene, core } = await startCore(t, "nested-region-groups");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [0, 0], to: [20, 20] });
  await sketch.primitives.add("circle", { center: [10, 10], diameter: 6 });
  await sketch.primitives.add("circle", { center: [40, 0], diameter: 4 });
  await sketch.primitives.add("line", { from: [-10, 0], to: [-5, 0] });
  const proxy = await sketch.getProxy();
  assert.equal(proxy.regions.length, 3);
  assert.deepEqual(proxy.regions.map(r => r.holes.length).sort(), [0, 0, 1]);
  assert.deepEqual(await sketch.getProxy(), proxy);
  const plate = proxy.regions.find(r => r.holes.length === 1)!;
  await sketch.complete();
  const feature = await core.solid.extrude(plate.region, { length1: 2 });
  near((await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value, (400 - 9 * Math.PI) * 2);
});
