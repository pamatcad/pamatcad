import assert from "node:assert/strict";
import { test } from "node:test";
import { Core, CoreError, WebSocketTransport, type BodyProxy } from "@pamatcad/sdk";
import { startCore } from "../../support/core.js";
import { circle, near, rectangle } from "../../support/extrude.js";

const code = (expected: string) => (e: unknown) => e instanceof CoreError && e.details?.code === expected;
function maxZ(proxy: BodyProxy) {
  return Math.max(...proxy.positions.filter((_, index) => index % 3 === 2));
}

test("cylinder triangles and polylines resolve to actual faces and edges", async (t) => {
  const { core, scene } = await startCore(t, "cylinder-proxy");
  const { profile } = await circle(scene, 5);
  const feature = await core.solid.extrude(profile, { length1: 10 });
  const body = await scene.bodies.get(feature.newSolids[0]!.id);
  const p = await scene.getProxyFor(body);
  assert.ok(p.positions instanceof Float32Array && p.normals instanceof Float32Array);
  assert.ok(p.triangles instanceof Uint32Array && p.edgePoints instanceof Float32Array);
  assert.equal(p.normals.length, p.positions.length);
  assert.ok(p.triangles.every((i) => i < p.positions.length / 3));
  assert.deepEqual(
    p.faces.map((f) => f.face),
    await body.faces.all(),
  );
  assert.equal(p.faces.length, 3);
  let triangle = 0;
  for (const group of p.faces) {
    assert.equal(group.firstTriangle, triangle);
    triangle += group.triangleCount;
  }
  assert.equal(triangle * 3, p.triangles.length);
  const side = await feature.faces.sideFaces1({ profile }).only();
  const wall = p.faces.find((group) => JSON.stringify(group.face) === JSON.stringify(side))!;
  assert.equal((await body.faces.properties(wall.face)).surface, "cylinder");
  assert.ok(wall.triangleCount > 2);
  for (const node of p.triangles.slice(
    3 * wall.firstTriangle,
    3 * (wall.firstTriangle + wall.triangleCount),
  )) {
    const x = p.positions[node * 3]!,
      y = p.positions[node * 3 + 1]!;
    near(x * p.normals[node * 3]! + y * p.normals[node * 3 + 1]!, 5, 1e-5);
  }
  const rims = p.edges.filter((e) => e.closed);
  assert.equal(rims.length, 2);
  assert.notEqual(rims[0]!.edge.edgeId, rims[1]!.edge.edgeId);
  for (const rim of rims) {
    assert.equal(rim.edge.revision, p.revision);
    assert.ok(rim.pointCount > 3);
    for (let i = rim.firstPoint; i < rim.firstPoint + rim.pointCount; i++) {
      near(Math.hypot(p.edgePoints[3 * i]!, p.edgePoints[3 * i + 1]!), 5, 1e-5);
    }
  }
});

test("explicit preview proxy lookup is session-scoped and expires on replacement, cancel and commit", async (t) => {
  const { core, scene, url } = await startCore(t, "preview-overlay");
  const { profile } = await rectangle(scene);
  const foreign = await WebSocketTransport.connect(url);
  t.after(() => foreign.close());
  const first = await core.solid.extrude(profile, { length1: 5 }, { preview: true });
  const ref = first.newSolids[0]!;
  assert.equal(maxZ(await scene.getProxyFor(ref, { preview: true })), 5);
  await assert.rejects(scene.getProxyFor(ref), code("NOT_FOUND"));
  await assert.rejects(
    foreign.request("scene.getProxyFor", { body: ref, preview: true }),
    code("PREVIEW_UNAVAILABLE"),
  );
  const other = await new Core(foreign).solid.extrude(profile, { length1: 7 }, { preview: true });
  const otherQuery = { body: other.newSolids[0]!, preview: true };
  assert.equal((await foreign.request("scene.getProxyFor", otherQuery)).revision, other.revision);
  assert.equal((await scene.getProxyFor(ref, { preview: true })).revision, first.revision);
  const second = await core.solid.extrude(profile, { length1: 15 }, { preview: true });
  await assert.rejects(scene.getProxyFor(ref, { preview: true }), code("PREVIEW_UNAVAILABLE"));
  await assert.rejects(
    scene.getProxyFor(second.newSolids[0]!, { preview: true, revision: first.revision }),
    code("INVALID_STATE"),
  );
  const proposed = await scene.getProxyFor(second.newSolids[0]!, {
    preview: true,
    revision: second.revision,
  });
  await scene.discardPreview();
  await assert.rejects(
    scene.getProxyFor(second.newSolids[0]!, { preview: true }),
    code("PREVIEW_UNAVAILABLE"),
  );
  const last = await core.solid.extrude(profile, { length1: 15 }, { preview: true });
  const feature = await core.solid.extrude(profile, { length1: 15 });
  await assert.rejects(foreign.request("scene.getProxyFor", otherQuery), code("PREVIEW_UNAVAILABLE"));
  const committed = await scene.getProxyFor(feature.newSolids[0]!);
  assert.deepEqual(committed.positions, proposed.positions);
  assert.deepEqual(committed.triangles, proposed.triangles);
  await assert.rejects(scene.getProxyFor(last.newSolids[0]!, { preview: true }), code("PREVIEW_UNAVAILABLE"));
});

test("a cut previews the same body ID at two geometries and handles removal", async (t) => {
  const { core, scene } = await startCore(t, "preview-cut");
  const { profile } = await rectangle(scene);
  const ref = (await core.solid.extrude(profile, { length1: 10 })).newSolids[0]!;
  const committed = await scene.getProxyFor(ref);
  const cut = await core.solid.extrude(profile, { mode: "cut", length1: 4 }, { preview: true });
  assert.deepEqual(cut.affectedSolids, [ref]);
  const replacement = await scene.getProxyFor(ref, { preview: true });
  assert.notEqual(replacement.revision, committed.revision);
  assert.equal(Math.min(...replacement.positions.filter((_, i) => i % 3 === 2)), 4);
  const removed = await core.solid.extrude(profile, { mode: "cut", length1: 10 }, { preview: true });
  assert.deepEqual(removed.removedSolids, [ref]);
  await assert.rejects(scene.getProxyFor(ref, { preview: true }), code("PREVIEW_UNAVAILABLE"));
  await scene.discardPreview();
  assert.deepEqual(await scene.getProxyFor(ref), committed);
});

test("a ten-operation batch requests display geometry only for the final scene", async (t) => {
  const { core, scene } = await startCore(t, "batch-proxies");
  const { profile } = await rectangle(scene);
  for (let i = 0; i < 10; i++) {
    await core.solid.extrude(profile, { length1: i + 1, mode: "newBody" });
  }
  const final = await scene.bodies.revisions();
  assert.equal(final.length, 10);
  const proxies = await Promise.all(final.map(({ body, revision }) => scene.getProxyFor(body, { revision })));
  assert.deepEqual(
    proxies.map(maxZ).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.ok((await scene.timeline.list()).every((entry) => !("proxy" in entry) && !("revision" in entry)));
});
