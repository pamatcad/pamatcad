import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../../support/core.js";

test("preview a cut through three cubes and commit it only to the outer two", { timeout: 30_000 }, async (t) => {
  const { core, scene } = await startCore(t, "cut-with-skips");
  const base = await scene.sketches.create(scene.construction.builtin.planes.xy);
  for (const x of [-20, 0, 20]) {
    await base.primitives.add("rectangle", { from: [x - 5, -5], to: [x + 5, 5] });
  }
  await base.complete();
  const profiles = await base.regions.all();
  assert.equal(profiles.length, 3);
  const block = await core.solid.extrude(profiles, { length1: 10 });
  assert.deepEqual(block.operation.inputs.profile, profiles);
  assert.equal(block.newSolids.length, 3);
  const entries = [{ type: "sketch", id: base.id }, { type: "extrude", id: block.id }];
  assert.deepEqual(await scene.timeline.list(), entries);

  const cubes = await Promise.all(block.newSolids.map(ref => scene.bodies.get(ref.id)));
  const [left, middle, right] = cubes;
  assert.ok(left && middle && right);
  const volumes = () => Promise.all(cubes.map(async body => (await body.properties()).volume.value));
  const before = await volumes();
  for (const value of before) assert.ok(Math.abs(value - 1000) < 1e-8);

  const face = await left.faces.query({ normal: [-1, 0, 0] }).only();
  const bore = await scene.sketches.create(face);
  // The face frame has U along +Y and V along −Z; (0, −5) is the face center.
  await bore.primitives.add("circle", { center: [0, -5], diameter: 5 });
  await bore.complete();
  entries.push({ type: "sketch", id: bore.id });
  const profile = await bore.regions.only();
  const options = { length1: -50, mode: "cut" } as const;
  const preview = await core.solid.extrude(profile, options, { preview: true });
  assert.deepEqual(preview.newSolids, []);
  assert.deepEqual(new Set(preview.affectedSolids.map(ref => ref.id)), new Set(cubes.map(cube => cube.id)));
  assert.equal(preview.affectedSolids.length, 3);
  assert.deepEqual(await scene.timeline.list(), entries);
  assert.deepEqual(await volumes(), before);

  const targets = await Promise.all(preview.affectedSolids
    .filter(ref => ref.id !== middle.id)
    .map(ref => scene.bodies.get(ref.id)));
  const cut = await core.solid.extrude(profile, { ...options, targets });
  assert.deepEqual(cut.newSolids, []);
  assert.deepEqual(new Set(cut.affectedSolids.map(ref => ref.id)), new Set([left.id, right.id]));
  assert.equal(cut.affectedSolids.length, 2);
  entries.push({ type: "extrude", id: cut.id });
  assert.deepEqual(await scene.timeline.list(), entries);
  const after = await volumes();
  const cutVolume = 1000 - Math.PI * 2.5 ** 2 * 10;
  for (const [i, expected] of [cutVolume, 1000, cutVolume].entries()) {
    assert.ok(Math.abs(after[i]! - expected) < 1e-8, `Cube ${i}: expected ${expected} mm³, got ${after[i]}`);
  }
});
