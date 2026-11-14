import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../../support/core.js";

test("extend a cube by extruding its top face in join mode", { timeout: 30_000 }, async (t) => {
  const { core, scene } = await startCore(t, "face-extrusion-join");
  const base = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await base.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
  await base.complete();
  const profile = await base.regions.only();
  const block = await core.solid.extrude(profile, { length: 10 });
  assert.equal(block.newSolids.length, 1);
  const cubeRef = block.newSolids[0]!;
  const cube = await scene.bodies.get(cubeRef.id);
  assert.ok(Math.abs((await cube.properties()).volume.value - 1000) < 1e-8);
  const entries = [{ type: "sketch", id: base.id }, { type: "extrude", id: block.id }];
  assert.deepEqual(await scene.timeline.list(), entries);

  const topFace = await block.faces.endCap1({ profile }).only();
  const join = await core.solid.extrude(topFace, { length: 5, mode: "join" });
  assert.deepEqual(join.operation.inputs.profile, topFace);
  assert.deepEqual(join.newSolids, []);
  assert.deepEqual(join.affectedSolids, [cubeRef]);
  assert.deepEqual(await scene.timeline.list(), [...entries, { type: "extrude", id: join.id }]);
  assert.ok(Math.abs((await cube.properties()).volume.value - 1500) < 1e-8);
  assert.deepEqual(await scene.bodies.all(), [cubeRef]);
  assert.deepEqual(await block.faces.endCap1({ profile }).all(), []);
  const newTop = await join.faces.endCap1({ profile: topFace }).only();
  assert.equal(newTop.bodyId, cubeRef.id);
});
