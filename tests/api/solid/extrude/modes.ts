import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core, CoreError, WebSocketTransport, type Transport, type Method, type Parameters } from "@pamatcad/sdk";
import { startCore } from "../../../support/core.js";
import { circle, near, rectangle, volume } from "../../../support/extrude.js";

test("Auto detects material and face contact; Intersect retains the union of overlaps, repeatably", async t => {
  const commands: { jsonrpc: "2.0"; id: number; method: Method; params: Parameters<Method> }[] = [];
  const responses: unknown[] = [];
  const { url } = await startCore(t, "extrude-modes-replay");
  const transport = await WebSocketTransport.connect(url);
  t.after(() => transport.close());
  const recording: Transport = {
    async request(method, params) {
      commands.push(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: commands.length + 1, method, params })));
      try {
        const result = await transport.request(method, params);
        responses.push({ result });
        return result;
      } catch (error) {
        responses.push({ error: error instanceof CoreError ? error.details : String(error) });
        throw error;
      }
    },
    close: () => transport.close(),
  };
  const core = new Core(recording);
  const scene = await core.scene.create("Auto mode");
  const { profile } = await rectangle(scene);
  const initial = await core.solid.extrude(profile, { length1: 10, mode: "auto" });
  assert.equal(initial.operation.resolvedMode, "newBody");
  assert.equal(initial.operation.parameters.mode, "auto");
  const ref = initial.newSolids[0]!;
  const body = await scene.bodies.get(ref.id);
  const revisions = await scene.bodies.revisions();
  const timeline = await scene.timeline.list();
  for (const [offset, expected] of [[20, "newBody"], [10, "join"], [5, "cut"]] as const) {
    const preview = await core.solid.extrude(profile, {
      start: { type: "offset", offset }, length1: 5, mode: "auto",
    }, { preview: true });
    assert.equal(preview.operation.resolvedMode, expected);
    assert.equal(preview.operation.parameters.mode, "auto");
    assert.equal(preview.newSolids.length, expected === "newBody" ? 1 : 0);
    assert.deepEqual(preview.affectedSolids, expected === "newBody" ? [] : [ref]);
    for (const r of [...preview.newSolids, ...preview.affectedSolids]) {
      const proxy = await scene.getProxyFor(r, { preview: true, revision: preview.revision });
      assert.equal(proxy.faces.length, 6);
    }
    near(await volume(body), 1000);
    assert.deepEqual(await scene.bodies.revisions(), revisions);
    assert.deepEqual(await scene.timeline.list(), timeline);
  }
  // Sharing only an edge or point must not try to form a non-manifold Join.
  const edge = (await rectangle(scene, [10, 10], [20, 20])).profile;
  for (const offset of [0, 10]) {
    const preview = await core.solid.extrude(edge, {
      start: { type: "offset", offset }, length1: 10, mode: "auto",
    }, { preview: true });
    assert.equal(preview.operation.resolvedMode, "newBody");
  }
  const joined = await core.solid.extrude(await initial.faces.endCap1({ profile }).only(), { length1: 5, mode: "auto" });
  assert.equal(joined.operation.resolvedMode, "join");
  assert.deepEqual(joined.affectedSolids, [ref]);
  near(await volume(body), 1500);
  const cut = await core.solid.extrude(profile, { length1: 5, mode: "auto" });
  assert.equal(cut.operation.resolvedMode, "cut");
  near(await volume(body), 1000);
  // Omitting mode still makes a new body, even with an overlapping target.
  const defaults = await core.solid.extrude(profile, { length1: 10 });
  assert.equal(defaults.newSolids.length, 1);
  assert.deepEqual(defaults.affectedSolids, []);
  assert.equal(defaults.operation.resolvedMode, undefined);
  // An explicit scope excludes otherwise overlapping scene bodies from detection.
  const scoped = await core.solid.extrude(profile, { length1: 3, mode: "auto", targets: [body] }, { preview: true });
  assert.equal(scoped.operation.resolvedMode, "newBody");
  near(await volume(body), 1000);
  const bore = await circle(scene, 2, [5, 5]);
  const through = await core.solid.extrude(bore.profile, { mode: "auto", extent1: { type: "throughAll" } });
  assert.equal(through.operation.resolvedMode, "cut");
  near(await volume(body), 1000 - 40 * Math.PI);
  near(await volume(await scene.bodies.get(defaults.newSolids[0]!.id)), 1000 - 40 * Math.PI);

  const intersectScene = await core.scene.create("Intersect mode");
  const base = await rectangle(intersectScene);
  const original = await core.solid.extrude(base.profile, { length1: 10 });
  const target = original.newSolids[0]!;
  const top = await original.faces.endCap1({ profile: base.profile }).only();
  const unrelated = await core.solid.extrude((await rectangle(intersectScene, [20, 0], [30, 10])).profile, { length1: 10 });
  const contained = await core.solid.extrude((await rectangle(intersectScene, [1, 20], [2, 21])).profile, { length1: 5 });
  const strips = await intersectScene.sketches.create(intersectScene.construction.builtin.planes.xy);
  await strips.primitives.add("rectangle", { from: [0, -1], to: [4, 30] });
  await strips.primitives.add("rectangle", { from: [6, -1], to: [10, 11] });
  await strips.complete();
  const profiles = await strips.regions.all();
  const before = await intersectScene.bodies.revisions();
  const beforeTimeline = await intersectScene.timeline.list();
  const preview = await core.solid.extrude(profiles, { length1: 10, mode: "intersect" }, { preview: true });
  assert.deepEqual(preview.affectedSolids, [target]);
  assert.equal(preview.newSolids.length, 1);
  assert.deepEqual(preview.removedSolids, []);
  near(preview.newSolidProperties[0]!.volume.value, 400);
  for (const r of [...preview.newSolids, ...preview.affectedSolids]) {
    const proxy = await intersectScene.getProxyFor(r, { preview: true, revision: preview.revision });
    assert.equal(proxy.faces.length, 6);
    assert.equal(proxy.edges.length, 12);
  }
  assert.deepEqual(await intersectScene.bodies.revisions(), before);
  assert.deepEqual(await intersectScene.timeline.list(), beforeTimeline);
  const result = await core.solid.extrude(profiles, { length1: 10, mode: "intersect" });
  assert.deepEqual(result.affectedSolids, [target]);
  assert.equal(result.newSolids.length, 1);
  assert.deepEqual(result.removedSolids, []);
  for (const r of [...result.affectedSolids, ...result.newSolids]) {
    const body = await intersectScene.bodies.get(r.id);
    near(await volume(body), 400);
    assert.equal((await body.faces.all()).length, 6);
  }
  const after = await intersectScene.bodies.revisions();
  for (const ref of [...unrelated.newSolids, ...contained.newSolids]) {
    assert.deepEqual(after.find(r => r.body.id === ref.id), before.find(r => r.body.id === ref.id));
  }
  near(await volume(await intersectScene.bodies.get(unrelated.newSolids[0]!.id)), 1000);
  near(await volume(await intersectScene.bodies.get(contained.newSolids[0]!.id)), 5);
  const caps = await original.faces.endCap1({ profile: base.profile }).all();
  assert.equal(caps.length, 2);
  await assert.rejects((await intersectScene.bodies.get(target.id)).faces.properties(top),
    e => e instanceof CoreError && e.details?.code === "AMBIGUOUS_FACE");
  const noOverlap = (await rectangle(intersectScene, [50, 0], [60, 10])).profile;
  for (const preview of [true, false]) {
    await assert.rejects(core.solid.extrude(noOverlap, { length1: 10, mode: "intersect" }, { preview }),
      e => e instanceof CoreError && e.details?.code === "INVALID_PARAMETER");
    assert.deepEqual(await intersectScene.bodies.revisions(), after);
  }

  // Signed lengths preserve Auto detection, preview state and face history on replay.
  const signed = await core.scene.create("Signed Auto extrusion");
  const signedProfile = (await rectangle(signed)).profile;
  const signedBase = await core.solid.extrude(signedProfile, { length1: 10 });
  const signedBody = await signed.bodies.get(signedBase.newSolids[0]!.id);
  const negative = { length1: "-5 mm", mode: "auto" } as const;
  const negativePreview = await core.solid.extrude(signedProfile, negative, { preview: true });
  assert.equal(negativePreview.operation.resolvedMode, "join");
  near(await volume(signedBody), 1000);
  const negativeJoin = await core.solid.extrude(signedProfile, negative);
  assert.equal(negativeJoin.operation.resolvedMode, "join");
  assert.deepEqual(negativeJoin.affectedSolids, negativePreview.affectedSolids);
  near(await volume(signedBody), 1500);
  const signedTop = await signedBase.faces.endCap1({ profile: signedProfile }).only();
  const inward = await core.solid.extrude(signedTop, { length1: -4, mode: "auto" });
  assert.equal(inward.operation.resolvedMode, "cut");
  near(await volume(signedBody), 1100);

  // Replay public JSON-RPC commands from a saved scenario in a fresh CLI process.
  const directory = await mkdtemp(join(tmpdir(), "pamatcad-modes-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "extrude-modes.jsonl");
  await writeFile(file, commands.map(command => JSON.stringify(command)).join("\n"));
  const replayCore = await startCore(t, "extrude-modes-replay");
  const replay = await WebSocketTransport.connect(replayCore.url);
  t.after(() => replay.close());
  const replayed = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const command = JSON.parse(line) as typeof commands[number];
    try { replayed.push({ result: await replay.request(command.method, command.params) }); }
    catch (error) { replayed.push({ error: error instanceof CoreError ? error.details : String(error) }); }
  }
  assert.deepEqual(replayed, responses);
});
