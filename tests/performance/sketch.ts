import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, arch, release } from "node:os";
import { resolve } from "node:path";
import { after, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Sketch, SketchEntityRef, SketchState } from "@pamatcad/sdk";
import { startCore } from "../support/core.js";

const runtime = process.env.PAMATCAD_TEST_RUNTIME;
assert.ok(runtime === "native" || runtime === "wasm", "Run through npm run test:performance to select and build a runtime");
const warmupCount = 3, sampleCount = 20;
type Sample = { dragMs: number; stateMs: number; geometryProxyMs: number; liveCycleMs: number; proxyMs: number; cycleMs: number };
type SolverProfile = {
  event: "sketch.solve"; drag: boolean; components: number; largestComponent: number; variables: number; equations: number;
  reusedComponents: number;
  buildMs: number; partitionMs?: number; totalMs: number;
  native: { prepareMs: number; diagnoseMs: number; solveMs: number; jacobianMs: number; freedomMs: number; attempts: number };
};
type Summary = { medianMs: number; p95Ms: number };
type Measurement = {
  name: string;
  geometry: { entities: number; curves: number; regions: number; constraints: number };
  first: Sample;
  warmup: Sample[];
  samples: Sample[];
  timings: Record<keyof Sample, Summary>;
  solverProfiles?: SolverProfile[];
  geometryProfiles?: unknown[];
};
const results: Measurement[] = [];
const creationResults: unknown[] = [];
const startedAt = new Date().toISOString();
const git = (args: string[]) => { try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const revision = git(["rev-parse", "HEAD"]), dirty = git(["status", "--porcelain"]);

after(async () => {
  const dir = resolve("reports/performance");
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${startedAt.replace(/[:.]/g, "-")}-${runtime}-sketch.json`);
  await writeFile(path, JSON.stringify({
    startedAt, runtime, build: "release", transport: runtime === "native" ? "websocket" : "in-process",
    node: process.version, platform: platform(), architecture: arch(), osRelease: release(),
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, revision, dirty: dirty === null ? null : dirty.length > 0,
    warmupCount, sampleCount, solverProfile: !!process.env.PAMATCAD_SKETCH_PROFILE, geometryProfile: !!process.env.PAMATCAD_GEOMETRY_PROFILE, results, creationResults,
  }, null, 2) + "\n");
  console.log(`Performance results: ${path}`);
});

function point(state: SketchState, ref: SketchEntityRef) {
  const geometry = state.entities.find(e => e.reference.id === ref.id)?.geometry;
  if (geometry?.type !== "point") throw new Error("Expected a drag point");
  return geometry.position;
}

async function measure(t: TestContext, sketch: Sketch, target: SketchEntityRef, expectedRegions: number, solverProfiles?: SolverProfile[]) {
  const initial = await sketch.state(), origin = point(initial, target);
  const interaction = async (index: number): Promise<Sample> => {
    const position: [number, number] = [origin[0] + (index % 2 ? 1 : -1), origin[1] + (index % 3 - 1) * 0.5];
    const start = performance.now();
    await sketch.drag(target, position);
    const dragged = performance.now();
    const state = await sketch.state();
    const read = performance.now();
    const geometry = await sketch.getProxy({ regions: false });
    const live = performance.now();
    const proxy = await sketch.getProxy();
    const end = performance.now();
    // Validation is outside the timed interval.
    const actual = point(state, target);
    assert.ok(Math.hypot(actual[0] - position[0], actual[1] - position[1]) < 1e-6, "Drag reaches its target");
    assert.equal(proxy.regions.length, expectedRegions);
    assert.deepEqual(geometry, { ...proxy, regions: null });
    return { dragMs: dragged - start, stateMs: read - dragged, geometryProxyMs: live - read, liveCycleMs: live - start,
      proxyMs: end - live, cycleMs: end - start };
  };
  const first = await interaction(0), warmup: Sample[] = [], samples: Sample[] = [];
  for (let i = 0; i < warmupCount; i++) warmup.push(await interaction(i + 1));
  for (let i = 0; i < sampleCount; i++) samples.push(await interaction(i + warmupCount + 1));
  const summarize = (key: keyof Sample): Summary => {
    const sorted = samples.map(s => s[key]).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return { medianMs: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]! };
  };
  const timings = { dragMs: summarize("dragMs"), stateMs: summarize("stateMs"), geometryProxyMs: summarize("geometryProxyMs"), liveCycleMs: summarize("liveCycleMs"), proxyMs: summarize("proxyMs"), cycleMs: summarize("cycleMs") };
  if (solverProfiles) {
    // stderr and the WebSocket are separate streams; collect the final profile outside the timed interval.
    for (let i = 0; solverProfiles.length < 1 + warmupCount + sampleCount && i < 100; i++) await delay(10);
    assert.equal(solverProfiles.length, 1 + warmupCount + sampleCount);
  }
  results.push({ name: t.name, geometry: {
    entities: initial.entities.length, curves: initial.entities.filter(e => e.geometry.type !== "point").length,
    regions: expectedRegions, constraints: initial.constraints.length,
  }, first, warmup, samples, timings, solverProfiles });
  t.diagnostic(JSON.stringify({ runtime, timings }));
}

async function slots(t: TestContext, count: number, connected = false) {
  const profiles: SolverProfile[] | undefined = process.env.PAMATCAD_SKETCH_PROFILE ? [] : undefined;
  const geometryProfiles: unknown[] | undefined = process.env.PAMATCAD_GEOMETRY_PROFILE ? [] : undefined;
  const { scene } = await startCore(t, t.name, "release", (profiles || geometryProfiles) && (line => {
    try {
      const value = JSON.parse(line);
      if (value.event === "sketch.solve" && value.drag) profiles?.push(value);
      if (["sketch.geometry", "sketch.regions"].includes(value.event)) geometryProfiles?.push(value);
    } catch { /* Other native diagnostics. */ }
  }));
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  // Construct the fixture without repeatedly solving it; measured drags use automatic recompute.
  await sketch.settings({ autoRecompute: false });
  let target: SketchEntityRef | undefined;
  let previousArc: SketchEntityRef | undefined;
  for (let i = 0; i < count; i++) {
    const x = (i % 10) * 20, y = Math.floor(i / 10) * 12;
    const slot = await sketch.primitives.add("slot", { from: [x, y], to: [x + 8, y], radius: 2 });
    target ??= slot.points.at(-1);
    if (connected && previousArc) await sketch.constraints.add("equal", { curves: [previousArc, slot.curves[0]!] });
    previousArc = slot.curves[0];
  }
  await sketch.settings({ autoRecompute: true });
  assert.ok(target);
  await measure(t, sketch, target, count, profiles);
  if (geometryProfiles) {
    const regions = () => geometryProfiles.filter(p => (p as { event: string }).event === "sketch.regions") as { groups: number; reused: number; rebuilt: number }[];
    for (let i = 0; regions().length < 1 + warmupCount + sampleCount && i < 100; i++) await delay(10);
    assert.equal(regions().length, 1 + warmupCount + sampleCount);
    assert.ok(regions().every(p => p.groups === count));
    if (!connected) assert.ok(regions().slice(1).every(p => p.reused === count - 1 && p.rebuilt === 1));
    results.at(-1)!.geometryProfiles = geometryProfiles;
  }
  if (profiles) assert.ok(profiles.every(p => p.components === (connected ? 1 : count)));
  if (profiles) assert.ok(profiles.every(p => p.reusedComponents === (connected ? 0 : count - 1)));
  if (connected) {
    const arcs = (await sketch.state()).entities.map(e => e.geometry).filter(g => g.type === "arc");
    assert.ok(arcs.every(a => Math.abs(a.radius - arcs[0]!.radius) < 1e-6));
  }
}

test("drag a slot in a sketch containing 10 slots", t => slots(t, 10));
test("drag a slot in a sketch containing 100 slots", t => slots(t, 100));
test("drag a slot in a sketch containing 10 slots linked by equal radii", t => slots(t, 10, true));
test("drag a text block with hundreds of outline curves", async t => {
  const { scene } = await startCore(t, t.name, "release");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const text = await sketch.primitives.add("text", { text: "This is a longer text block", origin: [0, 0], size: 10 });
  const frame = (await sketch.texts.get(text.id)).frame!;
  // Roboto's exact region decomposition includes the bounded counters of glyphs.
  await measure(t, sketch, frame.center, 31);
});

test("create a 15-letter text block and retrieve first and repeated proxies", async t => {
  const geometryProfiles: unknown[] | undefined = process.env.PAMATCAD_GEOMETRY_PROFILE ? [] : undefined;
  const { core } = await startCore(t, t.name, "release", geometryProfiles && (line => {
    try { const value = JSON.parse(line); if (["sketch.geometry", "sketch.text", "sketch.regions"].includes(value.event)) geometryProfiles.push(value); } catch { /* Other native diagnostics. */ }
  }));
  const interaction = async () => {
    const scene = await core.scene.create(t.name);
    try {
      const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
      const a = performance.now();
      await sketch.primitives.add("text", { text: "PerformanceTest", origin: [0, 0], size: 10 });
      const b = performance.now();
      const proxy = await sketch.getProxy();
      const c = performance.now();
      const repeated = await sketch.getProxy();
      const d = performance.now();
      assert.equal(proxy.regions.length, 21);
      assert.deepEqual(repeated, proxy);
      return { createMs: b - a, firstProxyMs: c - b, repeatedProxyMs: d - c };
    } finally { await scene.close(); }
  };
  const first = await interaction();
  const warmup: typeof first[] = [], samples: typeof first[] = [];
  for (let i = 0; i < warmupCount; i++) warmup.push(await interaction());
  for (let i = 0; i < sampleCount; i++) samples.push(await interaction());
  const timings = Object.fromEntries((Object.keys(first) as (keyof typeof first)[]).map(key => {
    const sorted = samples.map(s => s[key]).sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return [key, { medianMs: (sorted[middle - 1]! + sorted[middle]!) / 2, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]! }];
  }));
  creationResults.push({ name: t.name, text: "PerformanceTest", size: 10, first, warmup, samples, timings, geometryProfiles });
  t.diagnostic(JSON.stringify({ runtime, timings }));
});
