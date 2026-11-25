import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";

test("glyph cache warmed by a discarded preview preserves geometry and entity identities", async t => {
  const { scene, core } = await startCore(t, "glyph-cache-preview");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const parameters = { text: "oooooooooooooo", origin: [0, 0] as [number, number], size: 10 };
  const initial = await sketch.state();
  const cold = await sketch.primitives.add("text", parameters, { preview: true });
  const coldState = await sketch.state({ preview: true });
  const coldProxy = await sketch.getProxy({ preview: true });
  assert.equal(coldProxy.regions.filter(r => r.holes.length === 1).length, 14);
  await scene.discardPreview();
  assert.deepEqual(await sketch.state(), initial);
  const warm = await sketch.primitives.add("text", parameters);
  assert.deepEqual(warm, cold);
  assert.deepEqual(await sketch.state(), coldState);
  assert.deepEqual(await sketch.getProxy(), coldProxy);
  const other = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await other.primitives.add("text", parameters);
  assert.deepEqual((await other.state()).entities.map(e => [e.reference.id, e.geometry]), coldState.entities.map(e => [e.reference.id, e.geometry]));
  await sketch.complete();
  const feature = await core.solid.extrude(coldProxy.regions.filter(r => r.holes.length === 1).map(r => r.region), { length1: 1 });
  const volumes = await Promise.all(feature.newSolids.map(async r => (await (await scene.bodies.get(r.id)).properties()).volume.value));
  assert.equal(volumes.length, 14);
  for (const volume of volumes) near(volume, volumes[0]!);
});

test("glyph cache distinguishes font outlines and sizes while reusing translated glyphs", async t => {
  const { scene } = await startCore(t, "glyph-cache-keys");
  const base = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await base.primitives.add("text", { text: "B", origin: [0, 0], size: 10 });
  const original = (await base.state()).entities.map(e => e.geometry);
  const bold = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await bold.primitives.add("text", { text: "B", origin: [0, 0], size: 10, weight: 700 });
  assert.notDeepEqual((await bold.state()).entities.map(e => e.geometry), original);
  const larger = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const largeText = await larger.primitives.add("text", { text: "B", origin: [30, 20], size: 20 });
  assert.notDeepEqual((await larger.state()).entities.map(e => e.geometry), original);
  const baseProxy = await base.getProxy(), largerProxy = await larger.getProxy();
  const largePoints = largerProxy.curves.filter(c => !c.construction).flatMap(c => c.points);
  const basePoints = baseProxy.curves.filter(c => !c.construction).flatMap(c => c.points);
  near(Math.max(...largePoints.map(p => p[0])), 30 + 2 * Math.max(...basePoints.map(p => p[0])));
  near(Math.max(...largePoints.map(p => p[1])), 20 + 2 * Math.max(...basePoints.map(p => p[1])));
  // Force a content rebuild at the original size, rather than its affine fast path.
  await larger.texts.update(largeText.id, { text: "BB", origin: [0, 0], size: 10 });
  assert.equal((await larger.getProxy()).regions.filter(r => r.holes.length === 2).length, 2);
  const imported = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const fontBase64 = (await readFile("native/sketch/fonts/Roboto.ttf")).toString("base64");
  await imported.primitives.add("text", { text: "B", origin: [0, 0], size: 10, fontBase64 });
  assert.deepEqual((await imported.state()).entities.map(e => e.geometry), original);
});

test("cached glyphs rotate onto a guideline and a different support without changing their exact profile", async t => {
  const { scene, core } = await startCore(t, "glyph-cache-placement");
  const base = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const original = await base.primitives.add("text", { text: "B", origin: [0, 0], size: 10 });
  const baseState = await base.state();
  const rotated = await scene.sketches.create(scene.construction.builtin.planes.xz);
  const guide = await rotated.primitives.add("line", { from: [20, 30], to: [20, 130], construction: true });
  const placed = await rotated.primitives.add("text", { text: "B", origin: [20, 30], size: 10, guide: guide.curves[0] });
  const rotatedState = await rotated.state();
  assert.equal(placed.points.length, original.points.length);
  for (let i = 0; i < original.points.length; i++) {
    const a = baseState.entities.find(e => e.reference.id === original.points[i]!.id)!.geometry;
    const b = rotatedState.entities.find(e => e.reference.id === placed.points[i]!.id)!.geometry;
    assert.equal(a.type, "point"); assert.equal(b.type, "point");
    if (a.type !== "point" || b.type !== "point") assert.fail("Expected glyph control points");
    near(b.position[0], 20 - a.position[1]); near(b.position[1], 30 + a.position[0]);
  }
  const proxy = await rotated.getProxy();
  assert.ok(proxy.regions.every(r => r.boundary.every(p => Math.abs(p[1]) < 1e-7)));
  const profile = proxy.regions.find(r => r.holes.length === 2)!;
  assert.ok(profile);
  await rotated.complete();
  const feature = await core.solid.extrude(profile.region, { length1: 1 });
  near((await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value, 18.545449994418085);
});

test("editable text previews and conversion preserve exact regions and glyph holes", async t => {
  const { core, scene } = await startCore(t, "editable-text");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const created = await sketch.primitives.add("text", { text: "B", origin: [0, 0], size: "20 mm / 2" });
  const initial = await sketch.state(), proxy = await sketch.getProxy();
  assert.equal(initial.texts.length, 1);
  assert.equal(initial.texts[0]!.id, created.id);
  const formula = initial.texts[0]!.parameters.size;
  assert.equal(typeof formula, "object");
  if (typeof formula === "object") { assert.equal(formula.expression, "20 mm / 2"); near(formula.computed.value, 10); }
  await sketch.texts.update(created.id, { text: "OO" }, { preview: true });
  assert.equal((await sketch.state({ preview: true })).texts[0]!.parameters.text, "OO");
  assert.deepEqual(await sketch.state(), initial);
  await scene.discardPreview();
  await assert.rejects(sketch.getProxy({ preview: true }), /cached/);
  await sketch.complete();
  const region = proxy.regions.find(r => r.holes.length === 2)!;
  assert.ok(region);
  const extrusion = await core.solid.extrude(region.region, { length1: 2 });
  const volume = (await (await scene.bodies.get(extrusion.newSolids[0]!.id)).properties()).volume.value;
  assert.ok(volume > 0);
  await sketch.edit();
  const converted = await sketch.texts.explode(created.id);
  assert.deepEqual(converted.curves, created.curves);
  assert.deepEqual(converted.points, created.points);
  assert.deepEqual(converted.constraints, []);
  assert.deepEqual((await sketch.getProxy()).regions, proxy.regions);
  assert.deepEqual((await sketch.getProxy()).curves, proxy.curves);
  assert.deepEqual((await sketch.state()).texts, []);
  assert.ok((await sketch.state()).status.degreesOfFreedom > 0);
  await sketch.complete();
  near((await (await scene.bodies.get(extrusion.newSolids[0]!.id)).properties()).volume.value, volume);
});

test("text size and origin retain outline references through edits and downstream recomputation", async t => {
  const { core, scene } = await startCore(t, "text-affine-edit");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const created = await sketch.primitives.add("text", { text: "O", origin: [0, 0], size: 10 });
  const before = await sketch.getProxy();
  await sketch.complete();
  const region = before.regions.find(r => r.holes.length === 1)!.region;
  const feature = await core.solid.extrude(region, { length1: 3 });
  const volume = (await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value;
  await sketch.edit();
  const updated = await sketch.texts.update(created.id, { size: "20 mm", origin: [30, 20] });
  assert.equal(updated.id, created.id);
  assert.deepEqual(updated.geometry.curves, created.curves);
  await sketch.complete();
  near((await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value, volume * 4);
  await sketch.edit();
  await sketch.texts.update(created.id, { text: "B" });
  await assert.rejects(sketch.complete(), /region|profile|reference/i);
  await sketch.cancel();
  assert.equal((await sketch.texts.get(created.id)).parameters.text, "O");
});

test("multiline text uses block alignment and remains editable after reopen and cancellation", async t => {
  const { scene } = await startCore(t, "multiline-text");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const created = await sketch.primitives.add("text", { text: "B\nB", origin: [20, 30], size: "1 cm", horizontal: "center", vertical: "top" });
  const proxy = await sketch.getProxy(), points = proxy.curves.filter(c => !c.construction).flatMap(c => c.points);
  assert.equal(proxy.regions.filter(r => r.holes.length === 2).length, 2);
  assert.ok(points.every(([x, y]) => x > 10 && x < 30 && y < 30));
  assert.ok(Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1])) > 10);
  await sketch.complete(); await sketch.edit();
  await sketch.texts.update(created.id, { text: "Changed", horizontal: "right", vertical: "bottom" });
  await sketch.cancel();
  const restored = await sketch.texts.get(created.id);
  assert.equal(restored.parameters.text, "B\nB");
  assert.equal(restored.parameters.horizontal, "center");
  assert.deepEqual((await sketch.getProxy()).curves, proxy.curves);
});

test("text outlines reject independent edits and object removal is atomic", async t => {
  const { scene } = await startCore(t, "owned-text");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const created = await sketch.primitives.add("text", { text: "B", origin: [0, 0], size: 10 });
  const before = await sketch.state();
  await assert.rejects(sketch.remove([created.curves[0]!.id]), /convert/i);
  await assert.rejects(sketch.drag(created.points[0]!, [40, 20]), /convert/i);
  await assert.rejects(sketch.constraints.add("fix", { curves: [created.curves[0]!] }), /convert/i);
  await assert.rejects(sketch.texts.update(created.id, { size: "2 deg" }), /dimension|unit/i);
  await assert.rejects(sketch.texts.update(created.id, { text: "X".repeat(16385) }), /16384/);
  await assert.rejects(sketch.texts.update(created.id, { italic: true }), /italic/);
  assert.deepEqual(await sketch.state(), before);
  await sketch.remove([created.id]);
  assert.equal((await sketch.state()).entities.length, 1);
  assert.deepEqual((await sketch.state()).texts, []);
});

test("text formula follows dimensions and preserves its bound dependency", async t => {
  const { scene } = await startCore(t, "text-size-formula");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [30, 0], to: [40, 0], construction: true });
  const dimension = await sketch.dimensions.add("length", { line: line.curves[0], name: "size", value: "10 mm", mode: "driving" });
  const created = await sketch.primitives.add("text", { text: "B", origin: [0, 0], size: `sketches[${sketch.id}]dimension[size]` });
  await sketch.dimensions.update(dimension.id, { value: "20 mm", name: "renamed" });
  const text = await sketch.texts.get(created.id), formula = text.parameters.size;
  if (typeof formula !== "object") assert.fail("Expected evaluated text formula");
  near(formula.computed.value, 20);
  assert.equal(formula.references![0]!.dimension.id, dimension.id);
  assert.deepEqual(text.geometry.curves, created.curves);
  await assert.rejects(sketch.dimensions.remove(dimension.id), /referenc|unknown/i);
});

test("construction and whitespace text have no regions until valid normal outlines exist", async t => {
  const { scene } = await startCore(t, "text-construction");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const whitespace = await sketch.primitives.add("text", { text: " \n ", origin: [0, 0], size: 10 });
  assert.equal((await sketch.getProxy()).regions.length, 0);
  await sketch.remove([whitespace.id]);
  const created = await sketch.primitives.add("text", { text: "OO", origin: [0, 0], size: 10, construction: true });
  assert.equal((await sketch.getProxy()).regions.length, 0);
  await sketch.construction([created.curves[0]!], false);
  assert.equal((await sketch.texts.get(created.id)).parameters.construction, false);
  assert.equal((await sketch.getProxy()).regions.filter(r => r.holes.length === 1).length, 2);
});

test("text selects an explicit collection face and rejects nonexistent faces", async t => {
  const { scene } = await startCore(t, "text-font-collection");
  const original = await readFile("native/sketch/fonts/Roboto.ttf");
  const font = Buffer.from(original);
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const entry = 12 + i * 16;
    font.writeUInt32BE(font.readUInt32BE(entry + 8) + 20, entry + 8);
  }
  const header = Buffer.alloc(20);
  header.write("ttcf"); header.writeUInt32BE(0x00010000, 4); header.writeUInt32BE(2, 8);
  header.writeUInt32BE(20, 12); header.writeUInt32BE(20, 16);
  const fontBase64 = Buffer.concat([header, font]).toString("base64");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const created = await sketch.primitives.add("text", { text: "B", origin: [0, 0], size: 10, weight: 700, fontBase64, fontIndex: 1 });
  assert.equal((await sketch.texts.get(created.id)).parameters.fontIndex, 1);
  assert.ok((await sketch.getProxy()).regions.some(r => r.holes.length === 2));
  const before = await sketch.state();
  await assert.rejects(sketch.texts.update(created.id, { fontIndex: 2 }), /font/);
  assert.deepEqual(await sketch.state(), before);
});

test("text size follows another sketch through timeline replay and keeps its font data", async t => {
  const { core, scene } = await startCore(t, "text-external-formula");
  const source = await scene.sketches.create(scene.construction.builtin.planes.xy, { name: "source" });
  const line = await source.primitives.add("line", { from: [0, 0], to: [10, 0], construction: true });
  const dimension = await source.dimensions.add("length", { line: line.curves[0], name: "size", value: "10 mm", mode: "driving" });
  await source.complete();
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const fontBase64 = (await readFile("native/sketch/fonts/Roboto.ttf")).toString("base64");
  const text = await sketch.primitives.add("text", { text: "O", origin: [0, 0], size: "sketches[source]dimension[size]", fontBase64 });
  const region = (await sketch.getProxy()).regions.find(r => r.holes.length === 1)!.region;
  await sketch.complete();
  const feature = await core.solid.extrude(region, { length1: 2 });
  const volume = (await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value;
  await source.edit();
  await source.dimensions.update(dimension.id, { name: "renamed", value: "20 mm" });
  await source.complete();
  near((await (await scene.bodies.get(feature.newSolids[0]!.id)).properties()).volume.value, volume * 4);
  assert.equal((await sketch.texts.get(text.id)).parameters.fontBase64, fontBase64);
  assert.deepEqual((await sketch.texts.get(text.id)).geometry.curves, text.curves);
  await source.edit();
  await assert.rejects(source.dimensions.remove(dimension.id), /referenc/i);
  await source.cancel();
});

test("partial text updates merge atomically and optional font data can be cleared", async t => {
  const { scene } = await startCore(t, "text-partial-updates");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const fontBase64 = (await readFile("native/sketch/fonts/Roboto.ttf")).toString("base64");
  const created = await sketch.primitives.add("text", { text: "B", origin: [0, 0], size: 10, fontBase64, fontIndex: 0, weight: 700 });
  await Promise.all([
    sketch.texts.update(created.id, { text: "OO" }),
    sketch.texts.update(created.id, { size: "20 mm" }),
  ]);
  let text = await sketch.texts.get(created.id);
  assert.equal(text.parameters.text, "OO");
  assert.equal(text.parameters.fontBase64, fontBase64);
  if (typeof text.parameters.size !== "object") assert.fail("Expected evaluated text size");
  near(text.parameters.size.computed.value, 20);
  await sketch.texts.update(created.id, { fontBase64: null, fontIndex: null, weight: null });
  text = await sketch.texts.get(created.id);
  assert.equal(text.parameters.fontBase64, null);
  assert.equal(text.parameters.fontIndex, null);
  assert.equal(text.parameters.weight, null);
  assert.equal(text.parameters.text, "OO");
  assert.equal((await sketch.getProxy()).regions.filter(r => r.holes.length === 1).length, 2);
});
