import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { CoreError } from "@pamatcad/sdk";
import { startCore } from "../../../support/core.js";
import { near, rectangle, volume } from "../../../support/extrude.js";

async function adjacentCubes(t: TestContext, sceneName: string) {
  const { core, scene } = await startCore(t, sceneName);
  async function cubeAt(x: number) {
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const rectangle = await sketch.primitives.add("rectangle", { from: [x, 0], to: [x + 10, 10] });
    await sketch.complete();
    const profile = await sketch.regions.only();
    const feature = await core.solid.extrude(profile, { length1: 10 });
    const ref = feature.newSolids[0]!;
    const rightSide = feature.faces.sideFaces1({ profile, edge: rectangle.lines[1]! });
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
  const options = { mode: "cut", length1: 10 } as const;

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
  const options = { mode: "join", length1: 1 } as const;

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

for (const reverse of [false, true]) {
  test(`join skips an unchanged profile (${reverse ? "reversed" : "original"} order)`, async (t) => {
    const { core, scene } = await startCore(t, "join-with-unchanged-profile");
    const bodies = [];
    for (const [x, height] of [[0, 10], [20, 5]] as const) {
      const { profile } = await rectangle(scene, [x, 0], [x + 10, 10]);
      const feature = await core.solid.extrude(profile, { length1: height });
      bodies.push(await scene.bodies.get(feature.newSolids[0]!.id));
    }
    const [unchanged, changed] = bodies;
    const refs = await scene.bodies.all();
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    for (const x of [0, 20]) {
      await sketch.primitives.add("rectangle", { from: [x, 0], to: [x + 10, 10] });
    }
    await sketch.complete();
    const profiles = await sketch.regions.all();
    if (reverse) profiles.reverse();
    const before = await scene.timeline.list();
    const revisions = await scene.bodies.revisions();
    const originalMesh = await unchanged!.mesh();
    const options = { length1: 8, mode: "join" } as const;

    const preview = await core.solid.extrude(profiles, options, { preview: true });
    assert.deepEqual(preview.newSolids, []);
    assert.deepEqual(preview.removedSolids, []);
    assert.deepEqual(preview.affectedSolids, [refs.find(ref => ref.id === changed!.id)]);
    assert.deepEqual(await scene.timeline.list(), before);
    assert.deepEqual(await scene.bodies.revisions(), revisions);
    near(await volume(unchanged!), 1000);
    near(await volume(changed!), 500);
    const proxy = await scene.getProxyFor(preview.affectedSolids[0]!, { preview: true, revision: preview.revision });
    near(Math.max(...proxy.positions.filter((_, i) => i % 3 === 2)), 8);

    const feature = await core.solid.extrude(profiles, options);
    assert.deepEqual(feature.affectedSolids, preview.affectedSolids);
    assert.deepEqual(feature.newSolids, []);
    assert.deepEqual(feature.removedSolids, []);
    assert.deepEqual(await scene.bodies.all(), refs);
    near(await volume(unchanged!), 1000);
    near(await volume(changed!), 800);
    assert.deepEqual(await unchanged!.mesh(), originalMesh);
    const after = await scene.bodies.revisions();
    assert.deepEqual(after.find(r => r.body.id === unchanged!.id), revisions.find(r => r.body.id === unchanged!.id));
    assert.notEqual(after.find(r => r.body.id === changed!.id)!.revision, revisions.find(r => r.body.id === changed!.id)!.revision);
    const top = await changed!.faces.query({ normal: [0, 0, 1] }).only();
    near((await changed!.faces.properties(top)).centroid[2], 8);
    const committed = [...before, { type: "extrude", id: feature.id }];
    assert.deepEqual(await scene.timeline.list(), committed);

    for (const preview of [true, false]) {
      await assert.rejects(core.solid.extrude(profiles, options, { preview }),
        error => error instanceof CoreError && error.details?.code === "INVALID_PARAMETER");
    }
    assert.deepEqual(await scene.timeline.list(), committed);
    assert.deepEqual(await scene.bodies.revisions(), after);
    assert.deepEqual(await scene.bodies.all(), refs);
    near(await volume(unchanged!), 1000);
    near(await volume(changed!), 800);
  });
}
