import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../support/core.js";
import { near, rectangle, volume } from "../../support/extrude.js";

test("extrude a 10 × 10 mm square by the formula 20/ 2", async t => {
  const { core, scene } = await startCore(t, "formula-extrude");
  const { profile } = await rectangle(scene);
  const options = { length1: "20/ 2" };
  const before = await scene.timeline.list();
  const preview = await core.solid.extrude(profile, options, { preview: true });
  near(preview.newSolids[0]!.volume.value, 1000);
  assert.deepEqual(await scene.timeline.list(), before);

  const feature = await core.solid.extrude(profile, options);
  assert.deepEqual(feature.operation.parameters.length1, {
    expression: "20/ 2", dimension: "length", implicitUnit: "mm",
    computed: { value: 10, unit: "mm" },
  });
  assert.deepEqual(preview.operation.parameters, feature.operation.parameters);
  assert.equal(feature.newSolids.length, 1);
  const body = await scene.bodies.get(feature.newSolids[0]!.id);
  near(await volume(body), 1000);
  const cap = await feature.faces.endCap1({ profile }).only();
  near((await body.faces.properties(cap)).centroid[2], 10);
});
