import assert from "node:assert/strict";
import { test } from "node:test";
import { CoreError } from "@pamatcad/sdk";
import { startCore } from "../../../support/core.js";
import { block, checkSquare, near, rectangle, volume } from "../../../support/extrude.js";

test("one side starts at a negative offset", async t => {
  const { core, scene } = await startCore(t, "offset-start");
  await checkSquare(core, scene, { start: { type: "offset", offset: -3 }, length1: 8 }, 5, -3, 800);
});

test("one side starts at a parallel face", async t => {
  const { core, scene } = await startCore(t, "parallel-start-face");
  const support = await block(core, scene, 6, 1);
  const face = await support.feature.faces.endCap1({ profile: support.profile }).only();
  const { feature } = await checkSquare(core, scene, { start: { type: "object", face }, length1: 4 }, 11, 7, 400);
  assert.deepEqual(feature.affectedSolids, []);
  near(await volume(support.body), 100);
});

test("a tilted start face supplies its nearest point outside the footprint", async t => {
  const { core, scene } = await startCore(t, "tilted-start-face");
  const base = await rectangle(scene, [0,0], [10,10]);
  const support = await core.solid.extrude(base.profile, {
    length1: 8, start: { type: "offset", offset: 2 }, taperAngle1: 45,
  });
  const face = await support.faces.sideFaces1({ profile: base.profile, edge: base.lines[1]! }).only();
  // The side at +X spans x=10..18 and z=2..10. Above the profile it starts at x=13, z=5.
  const { profile } = await rectangle(scene, [13,2], [15,6]);
  const extrusion = await core.solid.extrude(profile, { start: { type: "object", face }, length1: 4 });
  const body = await scene.bodies.get(extrusion.newSolids[0]!.id);
  near((await body.faces.properties(await extrusion.faces.startCap({ profile })!.only())).centroid[2], 2);
  near((await body.faces.properties(await extrusion.faces.endCap1({ profile }).only())).centroid[2], 6);
  near(await volume(body), 32);
});

test("two unequal sides form one solid with numbered caps", async t => {
  const { core, scene } = await startCore(t, "unequal-sides");
  const { body, feature, profile } = await checkSquare(core, scene, { type: "twoSides", length1: 7, length2: 3 }, 7, -3, 1000);
  const sides1 = await feature.faces.sideFaces1({ profile }).all();
  const sides2 = await feature.faces.sideFaces2({ profile }).all();
  // Every boundary face is accounted for; there is no face on the join plane.
  const caps = [await feature.faces.endCap1({ profile }).only(), await feature.faces.endCap2({ profile }).only()];
  assert.deepEqual(new Set(await body.faces.all()), new Set([...caps, ...sides1, ...sides2]));
});

test("symmetric total length is centered on the offset start", async t => {
  const { core, scene } = await startCore(t, "symmetric-total-length");
  await checkSquare(core, scene, { type: "symmetric", start: { type: "offset", offset: 3 },
    symmetricLength: "total", length1: 8 }, 7, -1, 800);
});

test("symmetric half-length extends the specified distance each way", async t => {
  const { core, scene } = await startCore(t, "symmetric-half-length");
  await checkSquare(core, scene, { type: "symmetric", start: { type: "offset", offset: 3 },
    symmetricLength: "half", length1: 8 }, 11, -5, 1600);
});

test("one-sided extrusions reject second-side parameters and selectors", async t => {
  const { core, scene } = await startCore(t, "reject-second-side");
  const { profile } = await rectangle(scene);
  const before = await scene.timeline.list();
  const invalid = (e: unknown) => e instanceof CoreError && e.details?.code === "INVALID_PARAMETER";
  await assert.rejects(core.solid.extrude(profile, { length1: 6, length2: 3 }), invalid);
  assert.deepEqual(await scene.timeline.list(), before);
  assert.deepEqual(await scene.bodies.all(), []);
  const feature = await core.solid.extrude(profile, { length1: 6 });
  await assert.rejects(feature.faces.endCap2({ profile }).only(), invalid);
  await assert.rejects(feature.faces.sideFaces2({ profile }).all(), invalid);
});
