import assert from "node:assert/strict";
import type { Body, Core, ExtrudeParameters, Scene } from "@pamatcad/sdk";

export function near(actual: number, expected: number, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${expected}, got ${actual}`);
}

export async function rectangle(scene: Scene, from: [number, number] = [0, 0], to: [number, number] = [10, 10]) {
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const { lines } = await sketch.primitives.add("rectangle", { from, to });
  await sketch.complete();
  return { profile: await sketch.regions.only(), lines };
}

export async function circle(scene: Scene, radius: number, center: [number, number] = [0, 0]) {
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const { id } = await sketch.primitives.add("circle", { center, diameter: 2 * radius });
  await sketch.complete();
  return { profile: await sketch.regions.only(), edge: { id, sketchId: sketch.id, sceneId: scene.id } };
}

export async function block(core: Core, scene: Scene, startZ: number, length: number) {
  const { profile } = await rectangle(scene);
  const feature = await core.solid.extrude(profile, { start: { type: "offset", offset: startZ }, length1: length });
  const ref = feature.newSolids[0]!;
  return { feature, profile, ref, body: await scene.bodies.get(ref.id) };
}

export async function checkSquare(core: Core, scene: Scene, options: ExtrudeParameters,
                                  z1: number, zOther: number, volume: number) {
  const { profile } = await rectangle(scene);
  const feature = await core.solid.extrude(profile, options);
  assert.equal(feature.newSolids.length, 1);
  const body = await scene.bodies.get(feature.newSolids[0]!.id);
  const face1 = await feature.faces.endCap1({ profile }).only();
  near((await body.faces.properties(face1)).centroid[2], z1);
  const start = feature.faces.startCap({ profile });
  if (options.type === "symmetric" || options.type === "twoSides") assert.equal(start, null);
  const other = await (start ?? feature.faces.endCap2({ profile })).only();
  near((await body.faces.properties(other)).centroid[2], zOther);
  near((await body.properties()).volume.value, volume);
  return { feature, profile, body };
}

export async function volume(body: Body) { return (await body.properties()).volume.value; }
