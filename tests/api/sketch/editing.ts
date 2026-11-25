import assert from "node:assert/strict";
import { test } from "node:test";
import { startCore } from "../../support/core.js";
import { near } from "../../support/extrude.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core, WebSocketTransport, type Transport, type Method, type Parameters } from "@pamatcad/sdk";

test("Remove trims one line interval, preserves cutters and endpoints, and supports preview and repeated clicks", async t => {
  const { scene } = await startCore(t, "remove-line");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [0, 0], to: [30, 0], construction: true });
  const cutters = [];
  for (const x of [10, 20]) cutters.push(await sketch.primitives.add("line", { from: [x, -5], to: [x, 5] }));
  const fixed = await sketch.constraints.add("fix", { curves: cutters.flatMap(c => c.curves) });
  const before = await sketch.state();
  const operation = { type: "remove", position: [15, 0] } as const;
  const preview = await sketch.modifyCurves(line.curves, { ...operation, position: [...operation.position] }, { preview: true });
  assert.equal(preview.created.length, 2);
  assert.deepEqual(await sketch.state(), before);
  await scene.discardPreview();
  await assert.rejects(sketch.state({ preview: true }), /cached/);
  const result = await sketch.modifyCurves(line.curves, { ...operation, position: [...operation.position] });
  assert.deepEqual(result, preview);
  let state = await sketch.state();
  for (const ref of [...line.points, ...cutters.flatMap(c => [...c.points, ...c.curves])])
    assert.deepEqual(state.entities.find(e => e.reference.id === ref.id), before.entities.find(e => e.reference.id === ref.id));
  assert.ok(state.constraints.some(c => c.id === fixed.id));
  const segments = result.created.map(ref => {
    const e = state.entities.find(e => e.reference.id === ref.id)!;
    assert.ok(e.construction);
    if (e.geometry.type !== "line") assert.fail("Expected retained line");
    return [e.geometry.from, e.geometry.to].map(id => {
      const p = state.entities.find(e => e.reference.id === id)!.geometry;
      if (p.type !== "point") assert.fail("Expected endpoint");
      return p.position[0];
    }).sort((a, b) => a - b);
  }).sort((a, b) => a[0]! - b[0]!);
  assert.deepEqual(segments, [[0, 10], [20, 30]]);
  for (const ref of result.created) await sketch.modifyCurves([ref], { type: "remove", position: [0, 0] });
  state = await sketch.state();
  assert.ok(line.points.every(p => !state.entities.some(e => e.reference.id === p.id)));
  assert.deepEqual(state.entities.filter(e => e.geometry.type === "line").map(e => e.reference.id).sort(), cutters.flatMap(c => c.curves.map(r => r.id)).sort());
});

test("Remove rejects ambiguous, point, multiple and dimension-dependent targets atomically", async t => {
  const { scene } = await startCore(t, "remove-invalid");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [0, 0], to: [30, 0] });
  const cutter = await sketch.primitives.add("line", { from: [10, -5], to: [10, 5] });
  const before = await sketch.state();
  await assert.rejects(sketch.modifyCurves(line.curves, { type: "remove", position: [10, 0] }), /intersection/);
  await assert.rejects(sketch.modifyCurves(line.points, { type: "remove", position: [0, 0] }), /one curve/);
  await assert.rejects(sketch.modifyCurves([line.points[0]!], { type: "remove", position: [0, 0] }), /curve/);
  await assert.rejects(sketch.modifyCurves([...line.curves, ...cutter.curves], { type: "remove", position: [0, 0] }), /one curve/);
  await assert.rejects(sketch.modifyCurves([], { type: "remove", position: [0, 0] }), /one curve/);
  assert.deepEqual(await sketch.state(), before);
  const dimension = await sketch.dimensions.add("length", { line: line.curves[0], name: "span", mode: "driving", value: 30 });
  await sketch.dimensions.add("length", { line: cutter.curves[0], mode: "driving", value: "span / 3" });
  const dependent = await sketch.state();
  await assert.rejects(sketch.modifyCurves(line.curves, { type: "remove", position: [5, 0] }), /referenced dimension/);
  assert.deepEqual(await sketch.state(), dependent);
  await sketch.dimensions.remove(dependent.dimensions.find(d => d.id !== dimension.id)!.id);
  const result = await sketch.modifyCurves(line.curves, { type: "remove", position: [10 - 1e-4, 0] });
  assert.deepEqual(result.removedDimensions, [dimension.id]);
  assert.equal(result.created.length, 1);
});

for (const kind of ["circle", "ellipse"] as const) {
  test(`Remove keeps an exact ${kind} half across its seam on a rotated sketch plane`, async t => {
    const { core, scene } = await startCore(t, "remove-" + kind);
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.yz);
    const curve = kind === "circle"
      ? await sketch.primitives.add("circle", { center: [0, 0], diameter: 20 })
      : await sketch.primitives.add("ellipse", { center: [0, 0], major: 10, minor: 5 });
    const height = kind === "circle" ? 10 : 5;
    const cutter = await sketch.primitives.add("line", { from: [0, -height], to: [0, height] });
    const before = await sketch.state();
    const result = await sketch.modifyCurves([curve.curves[0]!], { type: "remove", position: [-10, 0] });
    assert.equal(result.created.length, 1, "Artificial seam must not split the retained interval");
    const state = await sketch.state();
    assert.deepEqual(state.entities.find(e => e.reference.id === cutter.curves[0]!.id), before.entities.find(e => e.reference.id === cutter.curves[0]!.id));
    const proxy = await sketch.getProxy();
    assert.equal(proxy.regions.length, 1);
    const retained = proxy.curves.find(c => c.entity.id === result.created[0]!.id)!;
    for (const p of retained.points) {
      near((p[1] / 10) ** 2 + (p[2] / height) ** 2, 1);
      assert.ok(p[1] >= -1e-6, "Retain the right half in the YZ sketch frame");
    }
    for (let repeat = 0; repeat < 3; repeat++) { await sketch.recompute(); assert.deepEqual((await sketch.state()).entities, state.entities); }
    await sketch.complete(); await sketch.edit(); assert.deepEqual((await sketch.state()).entities, state.entities); await sketch.complete();
    const solid = await core.solid.extrude(await sketch.regions.only(), { length1: 2 });
    const body = await scene.bodies.get(solid.newSolids[0]!.id);
    assert.equal((await body.faces.all()).length, 4);
    if (kind === "circle") near((await body.properties()).volume.value, Math.PI * 100, 1e-5);
  });
}

test("Remove handles isolated curves, a single closed-curve intersection and tangency", async t => {
  const { scene } = await startCore(t, "remove-whole");
  for (const kind of ["line", "circle", "ellipse", "spline", "tangent", "seam"] as const) {
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const curve = kind === "line" ? await sketch.primitives.add("line", { from: [0, 0], to: [10, 0] })
      : kind === "ellipse" ? await sketch.primitives.add("ellipse", { center: [0, 0], major: 10, minor: 5 })
      : kind === "spline" ? await sketch.primitives.add("spline", { points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true })
      : await sketch.primitives.add("circle", { center: [0, 0], diameter: 20 });
    const cutter = kind === "tangent" ? await sketch.primitives.add("line", { from: [-20, 10], to: [20, 10] })
      : kind === "seam" ? await sketch.primitives.add("line", { from: [10, 0], to: [20, 0] }) : undefined;
    const result = await sketch.modifyCurves([curve.curves[0]!], { type: "remove", position: [0, -10] });
    assert.deepEqual(result.created, [], kind);
    const state = await sketch.state();
    assert.equal(state.entities.length, cutter ? 4 : 1, kind + " cleans up owned helpers and unused points");
    assert.ok(state.entities.some(e => e.reference.id === "origin"));
    await sketch.cancel();
  }
});

test("Remove trims arcs and fit/control splines while excluding their protected helper polygons", async t => {
  const { scene } = await startCore(t, "remove-open-curves");
  for (const kind of ["arc", "fit", "control", "closed-fit", "closed-control"] as const) {
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const closed = kind.startsWith("closed");
    const curve = kind === "arc" ? await sketch.primitives.add("arc", { center: [10, 0], radius: 10, start: 0, end: 180 })
      : await sketch.primitives.add("spline", { points: closed ? [[0, 0], [20, 0], [20, 20], [0, 20]] : [[0, 0], [5, 10], [15, 10], [20, 0]], fit: kind.endsWith("fit"), closed });
    const cutter = await sketch.primitives.add("line", { from: [10, -10], to: [10, 30] });
    const before = await sketch.state();
    if (kind !== "arc") {
      await assert.rejects(sketch.modifyCurves([before.splines[0]!.envelope[0]!], { type: "remove", position: [0, 0] }), /construction/);
      assert.deepEqual(await sketch.state(), before);
    }
    const result = await sketch.modifyCurves([curve.curves[0]!], { type: "remove", position: [20, 5] });
    assert.ok(result.created.length >= 1 && result.created.length <= 2, kind);
    const proxy = await sketch.getProxy();
    const kept = proxy.curves.filter(c => result.created.some(r => r.id === c.entity.id));
    assert.ok(kept.every(c => c.points.every(p => p[0] <= 10 + 1e-6)), kind);
    assert.ok(kept.some(c => c.points.some(p => p[0] < 5)), kind);
    const state = await sketch.state();
    assert.deepEqual(state.entities.find(e => e.reference.id === cutter.curves[0]!.id), before.entities.find(e => e.reference.id === cutter.curves[0]!.id));
    assert.ok(before.splines.flatMap(s => s.envelope).every(r => !state.entities.some(e => e.reference.id === r.id)));
    await sketch.recompute(); assert.deepEqual(await sketch.getProxy(), proxy);
    await sketch.cancel();
  }
});

test("Remove uses projected boundaries without changing their read-only geometry", async t => {
  const { core, scene } = await startCore(t, "remove-projection");
  const source = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await source.primitives.add("rectangle", { from: [0, 0], to: [10, 10] }); await source.complete();
  const profile = await source.regions.only(), solid = await core.solid.extrude(profile, { length1: 2 });
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.projections.add({ type: "face", reference: await solid.faces.endCap1({ profile }).only() });
  const line = await sketch.primitives.add("line", { from: [-5, 5], to: [15, 5] });
  const before = await sketch.state(), projected = before.entities.filter(e => e.projected);
  await assert.rejects(sketch.modifyCurves([projected.find(e => e.geometry.type === "line")!.reference], { type: "remove", position: [0, 5] }), /read-only/);
  assert.deepEqual(await sketch.state(), before);
  const result = await sketch.modifyCurves(line.curves, { type: "remove", position: [5, 5] });
  assert.equal(result.created.length, 2);
  assert.deepEqual((await sketch.state()).entities.filter(e => e.projected), projected);
});

test("Remove produces a repeatable exact extrusion and replays captured public commands through the CLI", { skip: process.env.PAMATCAD_TEST_RUNTIME === "wasm" }, async t => {
  const commands: { jsonrpc: "2.0"; id: number; method: Method; params: Parameters<Method> }[] = [];
  const responses: unknown[] = [], snapshots = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    const { url } = await startCore(t, "remove-replay");
    const transport = await WebSocketTransport.connect(url); t.after(() => transport.close());
    const recording: Transport = { async request(method, params) {
      if (repeat === 0) commands.push(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: commands.length + 1, method, params })));
      const result = await transport.request(method, params);
      if (repeat === 0) responses.push(result);
      return result;
    }, close() { transport.close(); } };
    const core = new Core(recording), scene = await core.scene.create("Trim rectangle");
    const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    const bottom = (await sketch.primitives.add("line", { from: [-5, 0], to: [15, 0] })).curves[0]!;
    for (const [from, to] of [[[0, 0], [0, 10]], [[0, 10], [10, 10]], [[10, 10], [10, 0]]] as [[number, number], [number, number]][])
      await sketch.primitives.add("line", { from, to });
    await sketch.modifyCurves([bottom], { type: "remove", position: [-2, 0] });
    const state = await sketch.state();
    // Find the right overhang among the retained intervals from the first removal.
    const right = state.entities.find(e => e.geometry.type === "line" && [e.geometry.from, e.geometry.to].some(id => {
      const p = state.entities.find(e => e.reference.id === id)!.geometry;
      return p.type === "point" && p.position[0] === 15;
    }))!;
    await sketch.modifyCurves([right.reference], { type: "remove", position: [12, 0] });
    await sketch.complete();
    const result = await core.solid.extrude(await sketch.regions.only(), { length1: 3 });
    const body = await scene.bodies.get(result.newSolids[0]!.id);
    near((await body.properties()).volume.value, 300);
    assert.equal((await body.faces.all()).length, 6);
    snapshots.push({ state: await sketch.state(), proxy: await scene.getProxyFor(result.newSolids[0]!), properties: await body.properties() });
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
  const directory = await mkdtemp(join(tmpdir(), "pamatcad-remove-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "remove.jsonl");
  await writeFile(file, commands.map(command => JSON.stringify(command)).join("\n"));
  const { url } = await startCore(t, "remove-replay");
  const transport = await WebSocketTransport.connect(url); t.after(() => transport.close());
  const replayed = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const command = JSON.parse(line) as typeof commands[number];
    replayed.push(await transport.request(command.method, command.params));
  }
  assert.deepEqual(replayed, responses);
});
test("split intersects ordinary lines and preserves unrelated entity IDs", async (t) => {
  const { scene } = await startCore(t, "split-sketch");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await sketch.primitives.add("line", { from: [0, 0], to: [10, 10] });
  const b = await sketch.primitives.add("line", { from: [0, 10], to: [10, 0] });
  const other = await sketch.primitives.add("circle", { center: [30, 30], diameter: 4 });
  const result = await sketch.modifyCurves([...a.curves, ...b.curves], { type: "split" });
  assert.equal(result.removed.length, 2);
  assert.equal(result.created.length, 4);
  const state = await sketch.state();
  assert.ok(state.entities.some(e => e.reference.id === other.curves[0]!.id));
  const lines = state.entities.filter(e => result.created.some(r => r.id === e.reference.id));
  assert.equal(lines.length, 4);
  for (const e of lines) {
    assert.equal(e.geometry.type, "line");
    if (e.geometry.type !== "line") {
      continue;
    }
    const g = e.geometry;
    const p = state.entities.find(p => p.reference.id === g.from)!, q = state.entities.find(p => p.reference.id === g.to)!;
    assert.equal(p.geometry.type, "point");
    assert.equal(q.geometry.type, "point");
    if (p.geometry.type === "point" && q.geometry.type === "point") {
      near(Math.hypot(q.geometry.position[0] - p.geometry.position[0], q.geometry.position[1] - p.geometry.position[1]), Math.sqrt(50));
    }
  }
});
test("offset a circle on both sides without changing its source", async (t) => {
  const { scene } = await startCore(t, "offset-sketch");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [0, 0], diameter: 20 });
  const result = await sketch.modifyCurves(circle.curves, { type: "offset", distance1: "2 mm", distance2: "3 mm" });
  assert.deepEqual(result.removed, []);
  assert.equal(result.created.length, 2);
  const radii = (await sketch.state()).entities.filter(e => e.geometry.type === "circle").map(e => e.geometry.type === "circle" ? e.geometry.radius : 0).sort((a, b) => a - b);
  assert.deepEqual(radii.map(r => Math.round(r)), [7, 10, 12]);
});
test("round a corner with one radius and retain exact arcs", async (t) => {
  const { scene } = await startCore(t, "round-sketch");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const a = await sketch.primitives.add("line", { from: [0, 0], to: [10, 0] });
  const b = await sketch.primitives.add("line", { from: [10, 0], to: [10, 10] });
  const result = await sketch.modifyCurves([...a.curves, ...b.curves], { type: "rounding", radius: 2 });
  assert.equal(result.removed.filter(r => [...a.curves, ...b.curves].some(c => c.id === r.id)).length, 2);
  assert.equal(result.created.length, 3);
  const state = await sketch.state();
  assert.ok(!state.entities.some(e => e.geometry.type === "point" && e.geometry.position[0] === 10 && e.geometry.position[1] === 0), "Rounding removes the obsolete corner points");
  const arc = state.entities.find(e => e.geometry.type === "arc")!;
  assert.ok(arc);
  if (arc.geometry.type === "arc") {
    near(arc.geometry.radius, 2);
  }
});
test("move, rotate and scale copies retain source geometry and internal dimension bindings", async (t) => {
  const { scene } = await startCore(t, "transform-sketch");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const circle = await sketch.primitives.add("circle", { center: [10, 0], diameter: 10 });
  await sketch.dimensions.add("radius", { curve: circle.curves[0], name: "radius", mode: "driving", value: 5 });
  const copy = await sketch.transform({ entities: circle.curves, copy: true, pivot: [0, 0], translation: [0, 10], angle: 90, scale: "4/2" });
  const state = await sketch.state();
  const source = state.entities.find(e => e.reference.id === circle.curves[0]!.id)!, target = state.entities.find(e => e.reference.id === copy[0]!.id)!;
  if (source.geometry.type !== "circle" || target.geometry.type !== "circle") {
    assert.fail("Expected two circles");
  }
  near(source.geometry.radius, 5);
  near(target.geometry.radius, 10);
  const targetGeometry = target.geometry;
  const center = state.entities.find(e => e.reference.id === targetGeometry.center)!;
  if (center.geometry.type !== "point") {
    assert.fail("Expected center");
  }
  near(center.geometry.position[0], 0);
  near(center.geometry.position[1], 30);
  assert.equal(state.dimensions.length, 2);
});
test("manual recomputation exposes stale state and per-entity degrees of freedom", async (t) => {
  const { scene } = await startCore(t, "sketch-dof");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [0, 0], to: [10, 0] });
  let state = await sketch.state();
  assert.equal(state.status.entities.find(e => e.entity.id === line.curves[0]!.id)?.degreesOfFreedom, 4);
  await sketch.constraints.add("coincident", { points: [sketch.origin, line.points[0]!] });
  state = await sketch.state();
  assert.equal(state.status.entities.find(e => e.entity.id === line.curves[0]!.id)?.degreesOfFreedom, 2);
  await sketch.settings({ autoRecompute: false });
  await sketch.constraints.add("horizontal", { curves: line.curves });
  assert.equal((await sketch.state()).status.state, "stale");
  await sketch.recompute();
  state = await sketch.state();
  assert.equal(state.status.entities.find(e => e.entity.id === line.curves[0]!.id)?.degreesOfFreedom, 1);
});
test("a transform blocked by orientation constraints fails atomically", async (t) => {
  const { scene } = await startCore(t, "constrained-transform");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const rectangle = await sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
  const before = await sketch.state();
  const transform = { entities: rectangle.curves, pivot: [0, 0] as [number, number], angle: 45 };
  await assert.rejects(sketch.transform(transform), /Constraints prevent the requested transform/);
  assert.deepEqual(await sketch.state(), before);
  await sketch.constraints.remove(before.constraints.find(c => c.kind === "horizontal")!.id);
  await sketch.transform(transform);
  const after = await sketch.state();
  const points = rectangle.points.map(r => after.entities.find(e => e.reference.id === r.id)!.geometry);
  assert.ok(points.every(g => g.type === "point"));
  assert.ok(points.some(g => g.type === "point" && Math.abs(g.position[1] - Math.sqrt(200)) < 1e-7));
});

test("repeated perpendicular constraints return the original without mutating the sketch or preview", async t => {
  const { scene } = await startCore(t, "duplicate-perpendicular");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const rectangle = await sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
  const parameters = { curves: [rectangle.curves[0]!, rectangle.curves[1]!] };
  const original = await sketch.constraints.add("perpendicular", parameters);
  const before = await sketch.state(), proxy = await sketch.getProxy();
  const draft = await sketch.primitives.add("point", { position: [30, 40] }, { preview: true });
  const preview = await sketch.state({ preview: true });
  assert.deepEqual(await sketch.constraints.add("perpendicular", parameters), original);
  assert.deepEqual(await sketch.constraints.add("perpendicular", { curves: [...parameters.curves].reverse() }), original);
  assert.deepEqual(await sketch.state(), before);
  assert.deepEqual(await sketch.getProxy(), proxy);
  assert.deepEqual(await sketch.state({ preview: true }), preview);
  const committed = await sketch.primitives.add("point", { position: [30, 40] });
  assert.deepEqual(committed, draft, "Duplicates must not consume IDs");
  // An implied but distinct perpendicular pair still has its own identity.
  const distinct = await sketch.constraints.add("perpendicular", { curves: [rectangle.curves[3]!, rectangle.curves[0]!] });
  assert.notEqual(distinct.id, original.id);
  await sketch.settings({ autoRecompute: false });
  const manual = await sketch.state();
  assert.deepEqual(await sketch.constraints.add("perpendicular", parameters), original);
  assert.deepEqual(await sketch.state(), manual);
  await assert.rejects(sketch.constraints.add("perpendicular", { curves: [{ ...parameters.curves[0]!, sketchId: "missing" }, parameters.curves[1]!] }), /belong/);
  assert.deepEqual(await sketch.state(), manual);
  await sketch.complete();
  await assert.rejects(sketch.constraints.add("perpendicular", parameters), /complete/);
  await sketch.edit();
  const reopened = await sketch.state();
  assert.deepEqual(await sketch.constraints.add("perpendicular", parameters), original);
  assert.deepEqual(await sketch.state(), reopened);
});

test("repeated fixed constraints retain their ID and fixed values", async t => {
  const { scene } = await startCore(t, "duplicate-fix");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const line = await sketch.primitives.add("line", { from: [3, 4], to: [13, 4] });
  const original = await sketch.constraints.add("fix", { points: line.points });
  const before = await sketch.state(), proxy = await sketch.getProxy();
  assert.deepEqual(await sketch.constraints.add("fix", { points: line.points }), original);
  assert.deepEqual(await sketch.constraints.add("fix", { points: [...line.points].reverse() }), original);
  assert.deepEqual(await sketch.state(), before);
  assert.deepEqual(await sketch.getProxy(), proxy);
  await sketch.drag(line.points[0]!, [20, 20]);
  assert.deepEqual((await sketch.state()).entities, before.entities);
  const curveFix = await sketch.constraints.add("fix", { curves: line.curves });
  assert.notEqual(curveFix.id, original.id);
  assert.deepEqual(await sketch.constraints.add("fix", { curves: line.curves }), curveFix);
  await sketch.complete();
  await sketch.edit();
  const reopened = await sketch.state();
  assert.deepEqual(await sketch.constraints.add("fix", { points: line.points }), original);
  assert.deepEqual(await sketch.state(), reopened);
});
