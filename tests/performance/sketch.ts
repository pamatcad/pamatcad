import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, arch, release } from "node:os";
import { resolve } from "node:path";
import { after, test, type TestContext } from "node:test";
import type { Sketch, SketchEntityRef, SketchState } from "@pamatcad/sdk";
import { startCore } from "../support/core.js";

const runtime = process.env.PAMATCAD_TEST_RUNTIME;
assert.ok(runtime === "native" || runtime === "wasm", "Run through npm run test:performance to select and build a runtime");
const warmupCount = 3, sampleCount = 20;
type Sample = { dragMs: number; stateMs: number; proxyMs: number; cycleMs: number };
type Summary = { medianMs: number; p95Ms: number };
type Measurement = {
  name: string;
  geometry: { entities: number; curves: number; regions: number; constraints: number };
  first: Sample;
  warmup: Sample[];
  samples: Sample[];
  timings: Record<keyof Sample, Summary>;
};
const results: Measurement[] = [];
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
    warmupCount, sampleCount, results,
  }, null, 2) + "\n");
  console.log(`Performance results: ${path}`);
});

function point(state: SketchState, ref: SketchEntityRef) {
  const geometry = state.entities.find(e => e.reference.id === ref.id)?.geometry;
  if (geometry?.type !== "point") throw new Error("Expected a drag point");
  return geometry.position;
}

async function measure(t: TestContext, sketch: Sketch, target: SketchEntityRef, expectedRegions: number) {
  const initial = await sketch.state(), origin = point(initial, target);
  const interaction = async (index: number): Promise<Sample> => {
    const position: [number, number] = [origin[0] + (index % 2 ? 1 : -1), origin[1] + (index % 3 - 1) * 0.5];
    const start = performance.now();
    await sketch.drag(target, position);
    const dragged = performance.now();
    const state = await sketch.state();
    const read = performance.now();
    const proxy = await sketch.getProxy();
    const end = performance.now();
    // Validation is outside the timed interval.
    const actual = point(state, target);
    assert.ok(Math.hypot(actual[0] - position[0], actual[1] - position[1]) < 1e-6, "Drag reaches its target");
    assert.equal(proxy.regions.length, expectedRegions);
    return { dragMs: dragged - start, stateMs: read - dragged, proxyMs: end - read, cycleMs: end - start };
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
  const timings = { dragMs: summarize("dragMs"), stateMs: summarize("stateMs"), proxyMs: summarize("proxyMs"), cycleMs: summarize("cycleMs") };
  results.push({ name: t.name, geometry: {
    entities: initial.entities.length, curves: initial.entities.filter(e => e.geometry.type !== "point").length,
    regions: expectedRegions, constraints: initial.constraints.length,
  }, first, warmup, samples, timings });
  t.diagnostic(JSON.stringify({ runtime, timings }));
}

async function slots(t: TestContext, count: number) {
  const { scene } = await startCore(t, t.name, "release");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  // Construct the fixture without repeatedly solving it; measured drags use automatic recompute.
  await sketch.settings({ autoRecompute: false });
  let target: SketchEntityRef | undefined;
  for (let i = 0; i < count; i++) {
    const x = (i % 10) * 20, y = Math.floor(i / 10) * 12;
    const slot = await sketch.primitives.add("slot", { from: [x, y], to: [x + 8, y], radius: 2 });
    target ??= slot.points.at(-1);
  }
  await sketch.settings({ autoRecompute: true });
  assert.ok(target);
  await measure(t, sketch, target, count);
}

test("drag a slot in a sketch containing 10 slots", t => slots(t, 10));
test("drag a slot in a sketch containing 100 slots", t => slots(t, 100));
test("drag a text block with hundreds of outline curves", async t => {
  const { scene } = await startCore(t, t.name, "release");
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  const text = await sketch.primitives.add("text", { text: "This is a longer text block", origin: [0, 0], size: 10 });
  const frame = (await sketch.texts.get(text.id)).frame!;
  // Roboto's exact region decomposition includes the bounded counters of glyphs.
  await measure(t, sketch, frame.center, 31);
});
