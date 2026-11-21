import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core, CoreError, WebSocketTransport, type Transport, type Method, type Parameters, type FaceRef } from "@pamatcad/sdk";
import { startCore } from "../../../support/core.js";
import { near, rectangle, volume } from "../../../support/extrude.js";

const ambiguous = (error: unknown) => error instanceof CoreError && error.details?.code === "AMBIGUOUS_FACE";

test("split cuts preserve face history through repeated splits and rejoin, repeatably", async t => {
  const snapshots = [];
  const commands: { jsonrpc: "2.0"; id: number; method: Method; params: Parameters<Method> }[] = [];
  const responses: unknown[] = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    const { url } = await startCore(t, "split-cut-replay");
    const transport = await WebSocketTransport.connect(url);
    t.after(() => transport.close());
    const recording: Transport = {
      async request(method, params) {
        if (repeat === 0) commands.push(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: commands.length + 1, method, params })));
        try {
          const result = await transport.request(method, params);
          if (repeat === 0) responses.push({ result });
          return result;
        } catch (error) {
          if (repeat === 0) responses.push({ error: error instanceof CoreError ? error.details : String(error) });
          throw error;
        }
      },
      close: () => transport.close(),
    };
    const core = new Core(recording);
    const scene = await core.scene.create("Recorded split cut");
    const base = await rectangle(scene);
    const original = await core.solid.extrude(base.profile, { length1: 10 });
    const ref = original.newSolids[0]!;
    const body = await scene.bodies.get(ref.id);
    const top = original.faces.endCap1({ profile: base.profile });
    const oldTop = await top.only();
    const oldOrigin = await body.faces.query({ origin: { feature: original.id, role: "endCap1" } }).only();
    const strip = await rectangle(scene, [3, -1], [5, 11]);
    const options = { length1: 10, mode: "cut" } as const;
    const before = await scene.timeline.list();
    const revisions = await scene.bodies.revisions();
    const preview = await core.solid.extrude(strip.profile, options, { preview: true });
    assert.deepEqual(preview.affectedSolids, [ref]);
    assert.equal(preview.newSolids.length, 1);
    assert.deepEqual(preview.removedSolids, []);
    near(preview.newSolidProperties[0]!.volume.value, 300);
    for (const r of [...preview.affectedSolids, ...preview.newSolids]) {
      const proxy = await scene.getProxyFor(r, { preview: true, revision: preview.revision });
      assert.equal(proxy.faces.length, 6);
      assert.equal(proxy.edges.length, 12);
    }
    near(await volume(body), 1000);
    assert.deepEqual(await scene.timeline.list(), before);
    assert.deepEqual(await scene.bodies.revisions(), revisions);
    const cut = await core.solid.extrude(strip.profile, options);
    assert.deepEqual(cut.affectedSolids, [ref]);
    assert.equal(cut.newSolids.length, 1);
    near(await volume(body), 500);
    near(await volume(await scene.bodies.get(cut.newSolids[0]!.id)), 300);
    const properties = async (f: FaceRef) => (await scene.bodies.get(f.bodyId)).faces.properties(f);
    const splitTops = await top.all();
    assert.equal(splitTops.length, 2);
    await assert.rejects(top.only(), ambiguous);
    await assert.rejects(body.faces.properties(oldTop), ambiguous);
    await assert.rejects(body.faces.properties(oldOrigin), ambiguous);
    const fragment = await scene.bodies.get(cut.newSolids[0]!.id);
    await assert.rejects(fragment.faces.query({ origin: { feature: cut.id, role: "endCap1" } }).only(),
      error => error instanceof CoreError && error.details?.code === "NOT_FOUND");
    for (const f of splitTops) near((await properties(f)).centroid[2], 10);
    near((await properties(splitTops.find(f => f.bodyId === ref.id)!)).centroid[0], 7.5);
    assert.equal((await original.faces.startCap({ profile: base.profile })!.all()).length, 2);

    const strip2 = await rectangle(scene, [7, -1], [8, 11]);
    const second = await core.solid.extrude(strip2.profile, options);
    assert.deepEqual(second.affectedSolids, [ref]);
    assert.equal(second.newSolids.length, 1);
    near(await volume(body), 200);
    const tops = await top.all();
    assert.equal(tops.length, 3);
    near((await properties(tops.find(f => f.bodyId === ref.id)!)).centroid[0], 6);
    for (const f of tops) near((await properties(f)).centroid[2], 10);
    const splitSnapshot = await Promise.all((await scene.bodies.all()).map(async r => ({
      ref: r, volume: await volume(await scene.bodies.get(r.id)), proxy: await scene.getProxyFor(r),
    })));
    // Profiles from different sketches are not accepted; put both gap profiles in one sketch.
    const gaps = await scene.sketches.create(scene.construction.builtin.planes.xy);
    for (const [left, right] of [[3, 5], [7, 8]])
      await gaps.primitives.add("rectangle", { from: [left!, 0], to: [right!, 10] });
    await gaps.complete();
    const join = await core.solid.extrude(await gaps.regions.all(), { length1: 10, mode: "join" });
    assert.deepEqual(join.affectedSolids, [ref]);
    assert.equal(join.removedSolids.length, 2);
    assert.deepEqual(join.newSolids, []);
    assert.deepEqual(await scene.bodies.all(), [ref]);
    near(await volume(body), 1000);
    assert.equal((await body.faces.all()).length, 6);
    near((await body.faces.properties(await top.only())).areaMm2, 100);
    near((await body.faces.properties(oldTop)).areaMm2, 100);
    near((await body.faces.properties(oldOrigin)).areaMm2, 100);
    snapshots.push({ cut, second, join, splitSnapshot, top: await top.all(), proxy: await scene.getProxyFor(ref) });
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
  // Persist actual public JSON-RPC commands, then replay them against another CLI
  // process. No separate test-only modeling or save-document schema is involved.
  const directory = await mkdtemp(join(tmpdir(), "pamatcad-split-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "split-cut.jsonl");
  await writeFile(file, commands.map(command => JSON.stringify(command)).join("\n"));
  const { url } = await startCore(t, "split-cut-replay");
  const transport = await WebSocketTransport.connect(url);
  t.after(() => transport.close());
  const replayed = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const command = JSON.parse(line) as typeof commands[number];
    try { replayed.push({ result: await transport.request(command.method, command.params) }); }
    catch (error) { replayed.push({ error: error instanceof CoreError ? error.details : String(error) }); }
  }
  assert.deepEqual(replayed, responses);
});

test("one cut can split multiple targets", async t => {
  const { core, scene } = await startCore(t, "multiple-split-targets");
  const originals = [];
  for (const y of [0, 20]) {
    const { profile } = await rectangle(scene, [0, y], [10, y + 10]);
    originals.push((await core.solid.extrude(profile, { length1: 10 })).newSolids[0]!);
  }
  const { profile } = await rectangle(scene, [3, -1], [5, 31]);
  const preview = await core.solid.extrude(profile, { mode: "cut", length1: 10 }, { preview: true });
  assert.deepEqual(new Set(preview.affectedSolids), new Set(originals));
  assert.equal(preview.newSolids.length, 2);
  for (const r of originals) near(await volume(await scene.bodies.get(r.id)), 1000);
  const result = await core.solid.extrude(profile, { mode: "cut", length1: 10 });
  assert.deepEqual(new Set(result.affectedSolids), new Set(originals));
  assert.equal(result.newSolids.length, 2);
  assert.deepEqual(result.removedSolids, []);
  for (const r of originals) near(await volume(await scene.bodies.get(r.id)), 500);
  for (const r of result.newSolids) near(await volume(await scene.bodies.get(r.id)), 300);
});

test("offset cubes join with one continuous top and bottom", async t => {
  const { core, scene } = await startCore(t, "offset-cube-join");
  const a = await rectangle(scene);
  const original = await core.solid.extrude(a.profile, { length1: 10 });
  const ref = original.newSolids[0]!;
  const b = await rectangle(scene, [5, 5], [15, 15]);
  const second = await core.solid.extrude(b.profile, { length1: 10 });
  const preview = await core.solid.extrude(b.profile, { length1: 10, mode: "join" }, { preview: true });
  assert.equal((await scene.getProxyFor(ref, { preview: true, revision: preview.revision })).faces.length, 10);
  const joined = await core.solid.extrude(b.profile, { length1: 10, mode: "join" });
  assert.deepEqual(joined.removedSolids, second.newSolids);
  const body = await scene.bodies.get(ref.id);
  near(await volume(body), 1750);
  assert.equal((await body.faces.all()).length, 10);
  for (const [selector, z] of [["startCap", 0], ["endCap1", 10]] as const) {
    const f = await original.faces[selector]({ profile: a.profile })!.only();
    assert.deepEqual(f, await joined.faces[selector]({ profile: b.profile })!.only());
    const properties = await body.faces.properties(f);
    near(properties.areaMm2, 175);
    near(properties.centroid[2], z);
  }
});

for (const operation of ["consume", "join-from-fragment"] as const) {
  test(`split face history follows a surviving fragment after ${operation}`, async t => {
    const { core, scene } = await startCore(t, operation);
    const base = await rectangle(scene);
    const original = await core.solid.extrude(base.profile, { length1: 10 });
    const originalRef = original.newSolids[0]!;
    const originalBody = await scene.bodies.get(originalRef.id);
    const top = original.faces.endCap1({ profile: base.profile });
    const oldTop = await top.only();
    const gap = await rectangle(scene, [3, -1], [5, 11]);
    const split = await core.solid.extrude(gap.profile, { length1: 10, mode: "cut" });
    const fragmentRef = split.newSolids[0]!;
    const fragment = await scene.bodies.get(fragmentRef.id);
    if (operation === "consume") {
      const consume = await rectangle(scene, [5, 0], [10, 10]);
      await core.solid.extrude(consume.profile, { length1: 10, mode: "cut", targets: [originalBody] });
      near(await volume(fragment), 300);
    } else {
      const face = await fragment.faces.query({ normal: [1, 0, 0] }).only();
      const join = await core.solid.extrude(face, { length1: 2, mode: "join" });
      assert.deepEqual(join.affectedSolids, [fragmentRef]);
      near(await volume(fragment), 1000);
    }
    assert.deepEqual(await scene.bodies.all(), [fragmentRef]);
    assert.equal((await top.only()).bodyId, fragmentRef.id);
    near((await originalBody.faces.properties(oldTop)).centroid[2], 10);
    for (const face of await fragment.faces.all()) assert.ok((await fragment.faces.properties(face)).areaMm2 > 0);
  });
}
