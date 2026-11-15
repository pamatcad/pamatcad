import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../../support/core.js";

test("join a smaller cube to each of the six original faces", { timeout: 30_000 }, async (t) => {
  const { core, scene } = await startCore(t, "smaller-cube-on-each-face");
  const base = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const rectangle = await base.primitives.add("rectangle", { from: [-5, -5], to: [5, 5] });
  await base.complete();
  const profile = await base.regions.only();
  const block = await core.solid.extrude(profile, { length1: 10 });
  assert.equal(block.newSolids.length, 1);
  const cubeRef = block.newSolids[0]!;
  const cube = await scene.bodies.get(cubeRef.id);
  const top = await block.faces.endCap1({ profile }).only();
  const bottom = await block.faces.startCap({ profile }).only();
  const sides = await block.faces.sideFaces1({ profile }).all();
  assert.equal(sides.length, 4);
  assert.deepEqual(new Set([top, bottom, ...sides]), new Set(await cube.faces.all()));

  const sideByEdge = await Promise.all(rectangle.lines.map(edge =>
    block.faces.sideFaces1({ profile, edge }).only()));
  assert.deepEqual(new Set(sideByEdge), new Set(sides));

  // In rectangle boundary order the four side sketch centers are at V = +5, +5, −5, −5.
  const placements = [
    { face: top, v: 0 }, { face: bottom, v: 0 },
    ...sideByEdge.map((face, i) => ({ face, v: i < 2 ? 5 : -5 })),
  ];
  const entries = [{ type: "sketch", id: base.id }, { type: "extrude", id: block.id }];
  for (const { face, v } of placements) {
    const sketch = await scene.sketches.create(face);
    await sketch.primitives.add("rectangle", { from: [-1, v - 1], to: [1, v + 1] });
    await sketch.complete();
    const join = await core.solid.extrude(await sketch.regions.only(), { length1: 2, mode: "join" });
    assert.deepEqual(join.newSolids, []);
    assert.deepEqual(join.affectedSolids, [cubeRef]);
    entries.push({ type: "sketch", id: sketch.id }, { type: "extrude", id: join.id });
  }
  assert.equal(entries.length, 14);
  assert.deepEqual(await scene.timeline.list(), entries);
  assert.ok(Math.abs((await cube.properties()).volume.value - 1048) < 1e-8);
  assert.deepEqual(await scene.bodies.all(), [cubeRef]);
  assert.deepEqual(new Set(await block.faces.sideFaces1({ profile }).all()), new Set(sides));
});
