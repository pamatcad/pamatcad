import assert from "node:assert/strict";
import { test } from "node:test";
import type { Body, FaceRef } from "@pamatcad/sdk";
import { startCore } from "../../../support/core.js";
import { circle, near, volume } from "../../../support/extrude.js";

async function disk(body: Body, face: FaceRef, radius: number, z: number) {
  const p = await body.faces.properties(face);
  assert.equal(p.surface, "plane");
  near(p.areaMm2, Math.PI * radius ** 2);
  near(p.centroid[2], z);
}

const frustumVolume = Math.PI * 4 / 3 * (100 + 140 + 196);

test("one-sided taper expands a circular cap", async t => {
  const { core, scene } = await startCore(t, "one-sided-taper");
  const { profile } = await circle(scene, 10);
  const f = await core.solid.extrude(profile, { length1: 4, taperAngle1: 45 });
  const body = await scene.bodies.get(f.newSolids[0]!.id);
  await disk(body, await f.faces.startCap({ profile })!.only(), 10, 0);
  await disk(body, await f.faces.endCap1({ profile }).only(), 14, 4);
  near(await volume(body), frustumVolume);
});

test("an inward taper reaches full containment before its profile closes", async t => {
  const { core, scene } = await startCore(t, "inward-taper-to-object");
  const target = await circle(scene, 2);
  const cylinder = await core.solid.extrude(target.profile, {
    start: { type: "offset", offset: 1 }, length1: 15,
  });
  const { profile } = await circle(scene, 5);
  const feature = await core.solid.extrude(profile, {
    taperAngle1: -45,
    extent1: { type: "toObject", body: cylinder.newSolids[0]!, extent: "intersect" },
  });
  const body = await scene.bodies.get(feature.newSolids[0]!.id);
  await disk(body, await feature.faces.endCap1({ profile }).only(), 2, 3);
  near(await volume(body), 39 * Math.PI);
});

test("two independent tapers retain their source-edge side selectors", async t => {
  const { core, scene } = await startCore(t, "independent-tapers");
  const { profile, edge } = await circle(scene, 10);
  const f = await core.solid.extrude(profile, { type: "twoSides", length1: 4, length2: 4, taperAngle1: 45, taperAngle2: 0 });
  const body = await scene.bodies.get(f.newSolids[0]!.id);
  await disk(body, await f.faces.endCap1({ profile }).only(), 14, 4);
  await disk(body, await f.faces.endCap2({ profile }).only(), 10, -4);
  assert.equal((await body.faces.properties(await f.faces.sideFaces1({ profile, edge }).only())).surface, "cone");
  assert.equal((await body.faces.properties(await f.faces.sideFaces2({ profile, edge }).only())).surface, "cylinder");
  near(await volume(body), frustumVolume + 400 * Math.PI);
});

test("symmetric taper expands both ends from the original circle", async t => {
  const { core, scene } = await startCore(t, "symmetric-taper");
  const { profile } = await circle(scene, 10);
  const f = await core.solid.extrude(profile, { type: "symmetric", symmetricLength: "total", length1: 8, taperAngle1: 45 });
  const body = await scene.bodies.get(f.newSolids[0]!.id);
  await disk(body, await f.faces.endCap1({ profile }).only(), 14, 4);
  await disk(body, await f.faces.endCap2({ profile }).only(), 14, -4);
  near(await volume(body), 2 * frustumVolume);
});
