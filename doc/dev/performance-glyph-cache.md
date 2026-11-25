# Normalized glyph cache

2026-11-24. Scenario: `text so long and so on and so forth`, bundled Roboto, 10 mm; content edit: `text so forth and so on and so long`. Both produce 39 regions. Baseline: `ec637c4`.

## Measurements

Controlled WASM comparison: separate before/after engines in one Node process, alternating request order, four warm-up pairs and 20 measured pairs. The baseline Rust source was built separately against the same existing OCCT static libraries; the working project was unchanged. Timings include SDK serialization/dispatch and exclude browser worker transfer and rendering.

| Request | Before | Cached |
| --- | ---: | ---: |
| Creation, warm median | 350.5 ms | 7.9 ms |
| Content edit, warm median | 341.1 ms | 10.7 ms |
| First full proxy, median | 288.8 ms | 286.4 ms |
| Full proxy after content edit, median | 294.5 ms | 301.5 ms |
| Repeated unchanged proxy, median | 4.4 ms | 4.6 ms |

The first cold-cache creation pair measured 461 → 258 ms; this is one startup sample, not a startup percentile. Both builds produced 811 curves, 2235 points, 39 regions and 1696 region boundary samples. Creation p95 was 534.8 → 13.8 ms; first-proxy p95 was 353.2 → 451.1 ms, so these measurements do not establish equivalent tail latency.

Separate unprofiled native runs measured warmed creation 46.3 → 7.6 ms, content editing 49.9 → 10.4 ms, and first full proxy 36.3 → 36.1 ms. Native uses WebSocket transport; WASM uses in-process dispatch, so compare each runtime with its own baseline.

Earlier runs during heavy macOS XProtect activity showed much slower proxies. The alternating comparison did not reproduce a median proxy regression; it also shows no material full-region improvement. Proxy reconstruction remains separate from glyph normalization.

## Reuse and limits

Native profiling verifies 13 normalization misses and 14 hits on the first creation, then 27 hits and zero misses on every content edit and subsequent creation. Fourteen identical separated outlines normalize once, with thirteen hits on the first request and fourteen on the next. Placement, entity creation, constraints and response serialization still scale with the number of copies.

The engine shares an 8 MiB accounted-storage cache across sketches and previews. Exact local outlines determine reuse; overlapping glyphs retain joint winding normalization. Entries contain curves without model IDs, use least-recently-used eviction, and are not saved. See [cache ownership and bounds](sketches.md).

## Evidence

Raw reports under `reports/performance/`:

- Controlled WASM: `2026-11-24-glyph-cache-ab.json`.
- Native before/after: `2026-11-24T18-49-26-275Z-native-sketch.json` / `2026-11-24T19-03-45-803Z-native-sketch.json`.
- Native stages, cache assertions and all six scenarios: `2026-11-24T19-03-06-809Z-native-sketch.json`.
- All six WASM scenarios, affected by background load: `2026-11-24T18-54-15-750Z-wasm-sketch.json`.

Three Rust cache tests, 150 native API cases, 108 WASM sketch cases, the full browser suite, and web/desktop UI builds pass. Coverage includes eviction/bypass, repeated glyphs, opposite-winding overlap, preview/commit identity, font/size changes, holes, rotated guideline placement on another support, and exact extrusion volumes. Performance scenarios remain [opt-in](performance.md).
