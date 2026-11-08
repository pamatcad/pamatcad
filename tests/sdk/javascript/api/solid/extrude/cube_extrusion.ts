import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../../support/core.js";

test("extrude a 10 × 10 rectangle by 15", { timeout: 30_000 }, async (t) => {
  const { core } = await startCore(t);
  const scene = await core.scene.create("test-scene-1");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);

  await sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
  await sketch.complete();

  const profile = await sketch.regions.only();
  const feature = await core.solid.extrude(profile, { length: 15 });

  assert.equal(feature.newSolids.length, 1);
  assert.equal(feature.affectedSolids.length, 0);
  assert.equal(feature.operation.type, "extrude");
  assert.deepEqual(feature.operation.inputs.profile, profile);
  assert.equal(feature.operation.parameters.length, 15);

  const solid = await scene.bodies.get(feature.newSolids[0]!.id);
  const { volume } = await solid.properties();
  assert.equal(volume.unit, "mm3");
  assert.ok(Math.abs(volume.value - 1500) < 1e-8, `Expected 1500 mm3, received ${volume.value}`);
});

