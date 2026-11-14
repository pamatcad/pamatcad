import assert from "node:assert/strict";
import { test } from "node:test";
import { CoreError, type Body, type BodyRef, type ExtrudeParameters } from "@pamatcad/sdk";
import { startCore } from "../../../support/core.js";
import { block, circle, near, rectangle, volume } from "../../../support/extrude.js";

test("to-object stops at the selected limiting body", async t => {
  const { core, scene } = await startCore(t, "selected-limit");
  const nearer = await block(core, scene, 3, 1);
  const limit = await block(core, scene, 8, 2);
  const { profile } = await rectangle(scene, [2,2], [5,5]);
  const f = await core.solid.extrude(profile, { extent1: { type: "toObject", body: limit.ref, extent: "touch" } });
  const result = await scene.bodies.get(f.newSolids[0]!.id);
  near((await result.faces.properties(await f.faces.endCap1({ profile }).only())).centroid[2], 8);
  near(await volume(result), 72);
  near(await volume(nearer.body), 100);
  near(await volume(limit.body), 200);
});

test("one-sided through-all cuts both forward cubes and skips the rear cube", async t => {
  const { core, scene } = await startCore(t, "forward-through-all");
  const rear = await block(core, scene, -12, 10);
  const first = await block(core, scene, 2, 10);
  const last = await block(core, scene, 17, 10);
  const { profile } = await circle(scene, 2, [5,5]);
  const f = await core.solid.extrude(profile, { mode: "cut", extent1: { type: "throughAll" } });
  assert.deepEqual(new Set(f.affectedSolids), new Set([first.ref,last.ref]));
  assert.deepEqual(f.removedSolids, []);
  assert.deepEqual(f.newSolids, []);
  near(await volume(first.body), 1000 - 40 * Math.PI);
  near(await volume(last.body), 1000 - 40 * Math.PI);
  near(await volume(rear.body), 1000);
});

test("preview and commit a through-all cut and an opposite to-object cut together", async t => {
  const { core, scene } = await startCore(t, "mixed-cut-extents");
  const top = await block(core, scene, 0, 10);
  const bottom = await block(core, scene, -10, 10);
  const limit = await block(core, scene, -5, 1);
  const { profile } = await circle(scene, 2, [5,5]);
  const before = await scene.timeline.list();
  const options = { type: "twoSides", mode: "cut", targets: [top.body, bottom.body],
    extent1: { type: "throughAll" }, extent2: { type: "toObject", body: limit.ref, extent: "touch" } } satisfies ExtrudeParameters & { targets: Body[] };
  const preview = await core.solid.extrude(profile, options, { preview: true });
  assert.deepEqual(new Set(preview.affectedSolids), new Set([top.ref,bottom.ref]));
  assert.deepEqual(await scene.timeline.list(), before);
  near(await volume(top.body), 1000);
  near(await volume(bottom.body), 1000);
  const f = await core.solid.extrude(profile, options);
  assert.deepEqual(f.affectedSolids, preview.affectedSolids);
  assert.deepEqual(f.removedSolids, []);
  assert.deepEqual(await scene.timeline.list(), [...before,{ type: "extrude", id: f.id }]);
  near(await volume(top.body), 1000 - 40 * Math.PI);
  near(await volume(bottom.body), 1000 - 16 * Math.PI);
  near(await volume(limit.body), 100);
});

test("closest, touch, intersect and farthest stop at distinct planes on four cylinders", async t => {
  const { core, scene } = await startCore(t, "four-to-object-extents");
  const expectedBodies: BodyRef[] = [];
  async function group(x: number, extent: "closest" | "touch" | "intersect" | "farthest", z: number) {
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.xz);
    await sketch.primitives.add("circle", { center: [x,17], diameter: 30 });
    await sketch.complete();
    const cylinder = await core.solid.extrude(await sketch.regions.only(), { length1: 10 });
    const target = cylinder.newSolids[0]!;
    const { profile } = await rectangle(scene, [x+9,-8], [x+12,-2]);
    const f = await core.solid.extrude(profile, { mode: "newBody", extent1: { type: "toObject", body: target, extent } });
    assert.equal(f.newSolids.length, 1);
    assert.deepEqual(f.affectedSolids, []);
    assert.deepEqual(f.removedSolids, []);
    const ref = f.newSolids[0]!;
    const prism = await scene.bodies.get(ref.id);
    const cap = await prism.faces.properties(await f.faces.endCap1({ profile }).only());
    assert.equal(cap.surface, "plane");
    near(cap.centroid[2], z);
    near(cap.areaMm2, 18);
    near(await volume(prism), 18*z, 1e-5);
    near(await volume(await scene.bodies.get(target.id)), 2250*Math.PI);
    expectedBodies.push(target, ref);
  }
  await group(-40, "closest", 2);
  await group(0, "touch", 5);
  await group(40, "intersect", 8);
  await group(80, "farthest", 32);
  assert.deepEqual(new Set(await scene.bodies.all()), new Set(expectedBodies));
});

test("intersect rejects a cap spanning a through-hole even with all corners inside", async t => {
  const { core, scene } = await startCore(t, "incomplete-cap-containment");
  const limit = await block(core, scene, 4, 4);
  const bore = await circle(scene, 1, [5, 5]);
  await core.solid.extrude(bore.profile, { mode: "cut", extent1: { type: "throughAll" } });
  const { profile } = await rectangle(scene, [2, 2], [8, 8]);
  const options = { extent1: { type: "toObject", body: limit.ref, extent: "intersect" } } as const;
  const before = await scene.timeline.list();
  const invalid = (e: unknown) => e instanceof CoreError && e.details?.code === "INVALID_PARAMETER";
  await assert.rejects(core.solid.extrude(profile, options, { preview: true }), invalid);
  await assert.rejects(core.solid.extrude(profile, options), invalid);
  assert.deepEqual(await scene.timeline.list(), before);
  assert.deepEqual(await scene.bodies.all(), [limit.ref]);
  near(await volume(limit.body), 400 - 4 * Math.PI);
});
