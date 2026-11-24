import assert from "node:assert/strict";
import { test } from "node:test";
import type { SketchEntityRef, SketchState } from "@pamatcad/sdk";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";

function point(state: SketchState, ref: SketchEntityRef): [number, number] {
  const geometry = state.entities.find(e => e.reference.id === ref.id)!.geometry;
  assert.equal(geometry.type, "point");
  if (geometry.type !== "point") throw new Error("Expected point");
  return geometry.position;
}

test("text frames use typographic advances and font metrics, including blank lines and empty text", async t => {
  const { scene } = await startCore(t, "text-frame-layout");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const created = await sketch.primitives.add("text", { text: "B", origin: [20, 30], size: 10 });
  const frame = (await sketch.texts.get(created.id)).frame!;
  let state = await sketch.state();
  near(point(state, frame.bottomLeft)[0], 20);
  near(point(state, frame.bottomLeft)[1], 30 - 500 / 2048 * 10);
  near(point(state, frame.topLeft)[1], 30 + 1900 / 2048 * 10);
  const width = point(state, frame.bottomRight)[0] - 20;
  assert.equal(state.status.degreesOfFreedom, 3);
  for (const entity of state.entities.filter(e => e.geometry.type === "point")) {
    const freedom = state.status.entities.find(e => e.entity.id === entity.reference.id)!;
    assert.equal(freedom.unconstrainedDegreesOfFreedom, 2);
    assert.ok(freedom.degreesOfFreedom <= 2);
  }
  assert.equal(Object.keys(frame).length, 11);
  for (const ref of Object.values(frame)) assert.equal(state.entities.find(e => e.reference.id === ref.id)!.construction, true);
  const diagonal = state.entities.find(e => e.reference.id === frame.diagonal1.id)!.geometry;
  assert.deepEqual(diagonal, { type: "line", from: frame.bottomLeft.id, to: frame.topRight.id });
  await sketch.texts.update(created.id, { text: "B \n\n", horizontal: "center", vertical: "top" });
  state = await sketch.state();
  assert.deepEqual(state.texts[0]!.frame, frame);
  near(point(state, frame.topLeft)[1], 30);
  near(point(state, frame.bottomLeft)[1], 30 - 3 * 2400 / 2048 * 10);
  near(point(state, frame.center)[0], 20);
  assert.ok(point(state, frame.bottomRight)[0] - point(state, frame.bottomLeft)[0] > width, "Trailing space contributes to typographic width");
  assert.ok((await sketch.getProxy()).regions.some(r => r.holes.length === 2));
  await sketch.texts.update(created.id, { text: "" });
  state = await sketch.state();
  assert.deepEqual(state.texts[0]!.frame, frame);
  near(point(state, frame.bottomLeft)[0], point(state, frame.bottomRight)[0]);
  near(point(state, frame.topLeft)[1] - point(state, frame.bottomLeft)[1], 2400 / 2048 * 10);
  assert.equal(state.status.degreesOfFreedom, 3);
  assert.equal((await sketch.getProxy()).regions.length, 0);
  await sketch.texts.explode(created.id);
  await sketch.drag(frame.bottomRight, [30, 10]);
  near(point(await sketch.state(), frame.bottomRight)[0], 30);
  assert.equal((await sketch.getProxy()).regions.length, 0);
});

test("text center and orientation constraints survive content, font and alignment changes", async t => {
  const { scene } = await startCore(t, "text-frame-pose");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const created = await sketch.primitives.add("text", { text: "B", origin: [0, 0], size: 10 });
  const frame = (await sketch.texts.get(created.id)).frame!;
  await sketch.constraints.add("coincident", { points: [frame.center, sketch.origin] });
  const centered = await sketch.state(), unrotated = point(centered, created.points[0]!);
  const left = point(centered, frame.bottomLeft), right = point(centered, frame.bottomRight);
  const rotation = Math.PI / 6 - Math.atan2(right[1] - left[1], right[0] - left[0]);
  await sketch.dimensions.add("angle", { line: frame.bottom, value: 30, mode: "driving" });
  const before = await sketch.state(), p = point(before, created.points[0]!);
  near(p[0], unrotated[0] * Math.cos(rotation) - unrotated[1] * Math.sin(rotation));
  near(p[1], unrotated[0] * Math.sin(rotation) + unrotated[1] * Math.cos(rotation));
  const updated = await sketch.texts.update(created.id, { size: 20 });
  let state = await sketch.state();
  assert.deepEqual(updated, state.texts[0], "Update returns solved parameters");
  near(point(state, created.points[0]!)[0], 2 * p[0]);
  near(point(state, created.points[0]!)[1], 2 * p[1]);
  await sketch.texts.update(created.id, { text: "BB\nB", weight: 700, horizontal: "right", vertical: "bottom" });
  state = await sketch.state();
  assert.deepEqual(state.texts[0]!.frame, frame);
  near(point(state, frame.center)[0], 0); near(point(state, frame.center)[1], 0);
  const a = point(state, frame.bottomLeft), b = point(state, frame.bottomRight);
  near(Math.atan2(b[1] - a[1], b[0] - a[0]), Math.PI / 6);
  assert.equal(state.status.degreesOfFreedom, 0);
  await sketch.drag(frame.center, [10, 20]);
  near(point(await sketch.state(), frame.center)[0], 0);
  const glyphs = (await sketch.getProxy()).curves.filter(c => !c.construction);
  const origin = state.texts[0]!.parameters.origin;
  // Inverse rotation puts the right/bottom aligned glyphs to the left/above the anchor.
  assert.ok(glyphs.flatMap(c => c.points).every(([x, y]) => (x - origin[0]) * Math.cos(Math.PI / 6) + (y - origin[1]) * Math.sin(Math.PI / 6) < 0));
  assert.equal((await sketch.getProxy()).regions.filter(r => r.holes.length === 2).length, 3);
  await sketch.complete(); await sketch.edit();
  await sketch.texts.update(created.id, { text: "O" });
  await sketch.cancel();
  assert.deepEqual((await sketch.texts.get(created.id)).frame, frame);
  assert.equal((await sketch.texts.get(created.id)).parameters.text, "BB\nB");
});

test("text edge alignment follows a fixed construction line while the frame grows", async t => {
  const { scene } = await startCore(t, "text-frame-edge");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [25, -20], to: [25, 40], construction: true });
  await sketch.constraints.add("fix", { curves: line.curves });
  const created = await sketch.primitives.add("text", { text: "B", origin: [25, 0], size: 10 });
  const frame = (await sketch.texts.get(created.id)).frame!;
  await sketch.constraints.add("collinear", { curves: [line.curves[0]!, frame.left] });
  await sketch.texts.update(created.id, { text: "BBB", size: 20, horizontal: "right" });
  const state = await sketch.state();
  near(point(state, frame.bottomLeft)[0], 25); near(point(state, frame.topLeft)[0], 25);
  assert.ok(point(state, frame.bottomRight)[0] > 50);
  assert.ok(state.texts[0]!.parameters.origin[0] > 50);
  await sketch.drag(frame.center, [200, 20]);
  const dragged = await sketch.state();
  near(point(dragged, frame.bottomLeft)[0], 25);
  near(point(dragged, frame.center)[1], 20);
  assert.deepEqual(point(dragged, line.points[0]!), [25, -20]);
});

test("text frames reject independent edits and conflicting growth atomically", async t => {
  const { scene } = await startCore(t, "text-frame-conflict");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const created = await sketch.primitives.add("text", { text: "B", origin: [0, 0], size: 10 });
  const frame = (await sketch.texts.get(created.id)).frame!;
  await sketch.constraints.add("fix", { curves: [frame.bottom, frame.left] });
  const before = await sketch.state(), proxy = await sketch.getProxy();
  await assert.rejects(sketch.texts.update(created.id, { text: "BBBB" }), /constraint|solve/i);
  await assert.rejects(sketch.texts.update(created.id, { size: 20 }, { preview: true }), /constraint|solve/i);
  await assert.rejects(sketch.remove([frame.left.id]), /convert/i);
  await assert.rejects(sketch.drag(frame.topLeft, [10, 30]), /independently/i);
  await assert.rejects(sketch.construction([frame.left], false), /convert/i);
  await assert.rejects(sketch.transform({ entities: [frame.left], translation: [1, 0] }), /convert/i);
  await assert.rejects(sketch.modifyCurves([frame.left], { type: "offset", distance1: 1 }), /convert/i);
  assert.deepEqual(await sketch.state(), before);
  assert.deepEqual(await sketch.getProxy(), proxy);
  await sketch.remove([created.id]);
  assert.equal((await sketch.state()).entities.length, 1);
});

test("text frame conversion retains references and external constraints but releases sizing", async t => {
  const { scene } = await startCore(t, "text-frame-convert");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const created = await sketch.primitives.add("text", { text: "O", origin: [0, 0], size: 10 });
  const frame = (await sketch.texts.get(created.id)).frame!;
  const constraint = await sketch.constraints.add("coincident", { points: [frame.bottomLeft, sketch.origin] });
  const proxy = await sketch.getProxy();
  await sketch.texts.explode(created.id);
  const state = await sketch.state();
  assert.deepEqual(state.texts, []);
  assert.ok(state.constraints.some(c => c.id === constraint.id));
  for (const ref of Object.values(frame)) assert.ok(state.entities.some(e => e.reference.id === ref.id));
  assert.deepEqual((await sketch.getProxy()).regions, proxy.regions);
  await sketch.drag(frame.topRight, [50, 50]);
  const moved = await sketch.state();
  near(point(moved, frame.topRight)[0], 50); near(point(moved, frame.topRight)[1], 50);
  near(point(moved, frame.bottomLeft)[0], 0); near(point(moved, frame.bottomLeft)[1], 0);
  assert.deepEqual((await sketch.getProxy()).regions, proxy.regions);
});

test("text frame preview and manual center dragging preserve working geometry and placement", async t => {
  const { scene } = await startCore(t, "text-frame-preview");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const created = await sketch.primitives.add("text", { text: "B", origin: [0, 0], size: 10 });
  const frame = (await sketch.texts.get(created.id)).frame!;
  await sketch.constraints.add("coincident", { points: [frame.center, sketch.origin] });
  const before = await sketch.state();
  await sketch.texts.update(created.id, { text: "BBBB" }, { preview: true });
  const preview = await sketch.state({ preview: true });
  assert.deepEqual(preview.texts[0]!.frame, frame);
  near(point(preview, frame.center)[0], 0); near(point(preview, frame.center)[1], 0);
  assert.deepEqual(await sketch.state(), before);
  await scene.discardPreview();
  await sketch.constraints.remove(before.constraints[0]!.id);
  await sketch.settings({ autoRecompute: false });
  const origin = (await sketch.texts.get(created.id)).parameters.origin;
  await sketch.drag(frame.center, [10, 20]);
  let state = await sketch.state();
  near(state.texts[0]!.parameters.origin[0], origin[0] + 10);
  near(state.texts[0]!.parameters.origin[1], origin[1] + 20);
  near(point(state, frame.center)[0], 10); near(point(state, frame.center)[1], 20);
  await sketch.recompute(); state = await sketch.state();
  near(point(state, frame.center)[0], 10); near(point(state, frame.center)[1], 20);
  assert.ok((await sketch.getProxy()).regions.some(r => r.holes.length === 2));
});
