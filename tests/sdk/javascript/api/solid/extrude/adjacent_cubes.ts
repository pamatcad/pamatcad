import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { CoreError } from "@pamatcad/sdk";
import { startCore } from "../../../support/core.js";

async function adjacentCubes(t: TestContext, sceneName: string) {
  const { core, scene } = await startCore(t, sceneName);
  async function cubeAt(x: number) {
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const rectangle = await sketch.primitives.add("rectangle", { from: [x, 0], to: [x + 10, 10] });
    await sketch.complete();
    const profile = await sketch.regions.only();
    const feature = await core.solid.extrude(profile, { length: 10 });
    const ref = feature.newSolids[0]!;
    const rightSide = feature.faces.sideFaces({ profile, edge: rectangle.lines[1]! });
    return { ref, body: await scene.bodies.get(ref.id), rightSide };
  }

  // B is older. A's right face touches B.
  const b = await cubeAt(10);
  const a = await cubeAt(0);
  return { core, scene, a, b };
}

test("cut 10 mm to consume the adjacent cube", async (t) => {
  const { core, scene, a, b } = await adjacentCubes(t, "adjacent-cubes-cut");
  const shared = await a.rightSide.only();
  const before = await scene.timeline.list();
  const options = { mode: "cut", length: 10 } as const;

  const preview = await core.solid.extrude(shared, options, { preview: true });
  assert.deepEqual(preview.newSolids, []);
  assert.deepEqual(preview.affectedSolids, []);
  assert.deepEqual(preview.removedSolids, [b.ref]);
  assert.deepEqual(await scene.timeline.list(), before);
  assert.deepEqual(new Set(await scene.bodies.all()), new Set([a.ref, b.ref]));
  assert.ok(Math.abs((await a.body.properties()).volume.value - 1000) < 1e-8);
  assert.ok(Math.abs((await b.body.properties()).volume.value - 1000) < 1e-8);
  assert.equal((await b.rightSide.only()).bodyId, b.ref.id);

  const cut = await core.solid.extrude(shared, options);
  assert.deepEqual(cut.newSolids, []);
  assert.deepEqual(cut.affectedSolids, []);
  assert.deepEqual(cut.removedSolids, [b.ref]);
  assert.deepEqual(await scene.timeline.list(), [...before, { type: "extrude", id: cut.id }]);
  assert.deepEqual(await scene.bodies.all(), [a.ref]);
  await assert.rejects(scene.bodies.get(b.ref.id),
    error => error instanceof CoreError && error.details?.code === "NOT_FOUND");
  assert.ok(Math.abs((await a.body.properties()).volume.value - 1000) < 1e-8);
  assert.deepEqual(await a.rightSide.only(), shared);
  assert.deepEqual(await b.rightSide.all(), []);
});

test("join adjacent cubes with a 1 mm extrusion", async (t) => {
  const { core, scene, a, b } = await adjacentCubes(t, "adjacent-cubes-join");
  const shared = await a.rightSide.only();
  const before = await scene.timeline.list();
  const options = { mode: "join", length: 1 } as const;

  const preview = await core.solid.extrude(shared, options, { preview: true });
  assert.deepEqual(preview.newSolids, []);
  assert.deepEqual(preview.affectedSolids, [a.ref]);
  assert.deepEqual(preview.removedSolids, [b.ref]);
  assert.deepEqual(await scene.timeline.list(), before);
  assert.deepEqual(new Set(await scene.bodies.all()), new Set([a.ref, b.ref]));
  assert.ok(Math.abs((await a.body.properties()).volume.value - 1000) < 1e-8);
  assert.ok(Math.abs((await b.body.properties()).volume.value - 1000) < 1e-8);
  assert.equal((await b.rightSide.only()).bodyId, b.ref.id);

  const join = await core.solid.extrude(shared, options);
  assert.deepEqual(join.newSolids, []);
  assert.deepEqual(join.affectedSolids, [a.ref]);
  assert.deepEqual(join.removedSolids, [b.ref]);
  assert.deepEqual(await scene.timeline.list(), [...before, { type: "extrude", id: join.id }]);
  assert.deepEqual(await scene.bodies.all(), [a.ref]);
  await assert.rejects(scene.bodies.get(b.ref.id),
    error => error instanceof CoreError && error.details?.code === "NOT_FOUND");
  assert.ok(Math.abs((await a.body.properties()).volume.value - 2000) < 1e-8);
  assert.deepEqual(await a.rightSide.all(), []);
  assert.equal((await b.rightSide.only()).bodyId, a.ref.id);
});
