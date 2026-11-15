import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../../support/core.js";

test("cut an 8 mm blind hole 5 mm into the end face of a 10 mm cube", { timeout: 30_000 }, async (t) => {
  const { core, scene } = await startCore(t, "cube-with-hole");
  const base = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await base.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
  await base.complete();
  const block = await core.solid.extrude(await base.regions.only(), { length1: 10 });
  const [cubeRef] = block.newSolids;
  assert.ok(cubeRef);
  const cube = await scene.bodies.get(cubeRef.id);
  const top = await cube.faces.query({ origin: { feature: block.id, role: "endCap1" } }).only();

  const sketch = await scene.sketches.create(top);
  await sketch.primitives.add("circle", { center: [5, 5], diameter: 8 });
  await sketch.complete();
  const profile = await sketch.regions.only();
  const cut = await core.solid.extrude(profile, { length1: -5, mode: "cut", targets: [cube] });

  assert.deepEqual(cut.operation.inputs, { profile, targets: [cubeRef] });
  assert.deepEqual(cut.operation.parameters, { length1: -5, mode: "cut" });
  assert.deepEqual(cut.newSolids, []);
  assert.deepEqual(cut.affectedSolids, [cubeRef]);
  const { volume } = await cube.properties();
  const expected = 1000 - Math.PI * 4 ** 2 * 5;
  assert.equal(volume.unit, "mm3");
  assert.ok(Math.abs(volume.value - expected) < 1e-8, `Expected ${expected} mm3, received ${volume.value}`);
});
