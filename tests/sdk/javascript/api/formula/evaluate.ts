import assert from "node:assert/strict";
import { test } from "node:test";
import { CoreError } from "@pamatcad/sdk";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";

test("evaluate an angle formula in scene units without creating a feature", async t => {
  const { core, scene } = await startCore(t, "evaluate-formula");
  assert.deepEqual(scene.units, { length: "mm", angle: "deg" });
  const angle = { expectedDimension: "angle" } as const;
  const result = await scene.evaluateFormula("90 / 2", angle);
  assert.deepEqual(result, {
    expression: "90 / 2", dimension: "angle", implicitUnit: "deg",
    computed: { value: 45, unit: "deg" },
  });

  const radians = await core.scene.create("radians", { length: "in", angle: "rad" });
  const rebound = await radians.evaluateFormula(result, angle);
  assert.equal(rebound.implicitUnit, "deg");
  assert.equal(rebound.computed.unit, "rad");
  near(rebound.computed.value, Math.PI / 4);

  const invalid = (e: unknown) => e instanceof CoreError && e.details?.code === "INVALID_PARAMETER";
  await assert.rejects(scene.evaluateFormula("2 mm", angle), invalid);
  await assert.rejects(scene.evaluateFormula("1 / 0", angle), invalid);
  assert.deepEqual(await scene.timeline.list(), []);
  assert.deepEqual(await radians.timeline.list(), []);
});
