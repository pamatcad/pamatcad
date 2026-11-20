import assert from "node:assert/strict";
import { test } from "node:test";
import { Core, CoreError, WebSocketTransport } from "@pamatcad/sdk";
import { startCore } from "../../support/core.js";
import { near, rectangle } from "../../support/extrude.js";

const code = (expected: string) => (error: unknown) => error instanceof CoreError && error.details?.code === expected;

test("closing a scene expires references and every session preview while preserving other scenes", async (t) => {
  // Keep the fixture scene alive so the report captures the surviving document.
  const { core, scene: survivor, url } = await startCore(t, "scene-close-survivor");
  const closing = await core.scene.create("scene-to-close");
  const sketch = await closing.sketches.create(closing.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
  await sketch.complete();
  const profile = await sketch.regions.only();
  const feature = await core.solid.extrude(profile, { length1: 10 });
  const reference = feature.newSolids[0]!;
  const body = await closing.bodies.get(reference.id);
  const face = await feature.faces.endCap1({ profile }).only();
  near((await body.properties()).volume.value, 1000);

  const { profile: survivingProfile } = await rectangle(survivor);
  const survivingFeature = await core.solid.extrude(survivingProfile, { length1: 8 });
  const survivingReference = survivingFeature.newSolids[0]!;
  const survivingBody = await survivor.bodies.get(survivingReference.id);
  const timeline = await survivor.timeline.list();
  const properties = await survivingBody.properties();
  const revisions = await survivor.bodies.revisions();
  near(properties.volume.value, 800);

  const otherSession = await WebSocketTransport.connect(url);
  t.after(() => otherSession.close());
  const first = await core.solid.extrude(profile, { mode: "cut", length1: 3 }, { preview: true });
  const second = await new Core(otherSession).solid.extrude(profile, { mode: "cut", length1: 6 }, { preview: true });
  assert.deepEqual(first.affectedSolids, [reference]);
  assert.deepEqual(second.affectedSolids, [reference]);
  assert.notEqual(first.revision, second.revision);
  assert.equal((await closing.getProxyFor(reference, { preview: true })).revision, first.revision);
  assert.equal((await otherSession.request("scene.getProxyFor", { body: reference, preview: true })).revision, second.revision);

  await closing.close();

  await assert.rejects(closing.timeline.list(), code("NOT_FOUND"));
  await assert.rejects(closing.bodies.all(), code("NOT_FOUND"));
  await assert.rejects(closing.bodies.get(reference.id), code("NOT_FOUND"));
  await assert.rejects(body.properties(), code("NOT_FOUND"));
  await assert.rejects(body.faces.properties(face), code("NOT_FOUND"));
  await assert.rejects(sketch.regions.only(), code("NOT_FOUND"));
  await assert.rejects(closing.getProxyFor(reference), code("NOT_FOUND"));
  await assert.rejects(closing.getProxyFor(reference, { preview: true }), code("PREVIEW_UNAVAILABLE"));
  await assert.rejects(
    otherSession.request("scene.getProxyFor", { body: reference, preview: true }),
    code("PREVIEW_UNAVAILABLE"),
  );

  assert.deepEqual(await survivor.bodies.all(), [survivingReference]);
  assert.deepEqual(await survivor.bodies.revisions(), revisions);
  assert.deepEqual(await survivor.timeline.list(), timeline);
  assert.deepEqual(await survivingBody.properties(), properties);
  const cut = await core.solid.extrude(survivingProfile, { mode: "cut", length1: 2 });
  assert.deepEqual(cut.affectedSolids, [survivingReference]);
  assert.deepEqual(await survivor.bodies.all(), [survivingReference]);
  near((await survivingBody.properties()).volume.value, 600);
  assert.deepEqual(await survivor.timeline.list(), [...timeline, { type: "extrude", id: cut.id }]);
});

test("repeated scene close fails and a new scene does not reuse the closed ID", async (t) => {
  const { core } = await startCore(t, "scene-close-identity");
  const closing = await core.scene.create("closed");
  await closing.close();
  await assert.rejects(closing.close(), code("NOT_FOUND"));

  const created = await core.scene.create("new");
  assert.notEqual(created.id, closing.id);
  assert.deepEqual(await created.timeline.list(), []);
  await assert.rejects(closing.timeline.list(), code("NOT_FOUND"));
});
