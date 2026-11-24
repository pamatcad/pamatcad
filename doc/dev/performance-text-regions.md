# Text creation, full regions and first-proxy comparison

2026-11-24. Baseline: `9d3b7c6`. Measurements use the production WASM module in Node, excluding browser worker transfer and viewport rendering. Each scenario records its first interaction, three warm-ups and 20 measured interactions. These are warmed-module medians; fresh scenes have no cached regions.

## Results

- 15-letter creation (`PerformanceTest`, bundled Roboto, 10 mm): **231 → 182 ms**.
- Full proxy after moving one of 100 independent slots: **189 → 12.7 ms**. Native instrumentation verifies **99 reused groups and one rebuilt group** after the initial request.
- First full proxy for the 15-letter text: **137 → 141 ms**; no demonstrated improvement.
- Full proxy after moving the entire long text: **186 → 183 ms**; effectively unchanged. Every group's coordinates change, so this case still rebuilds all regions.
- Repeated unchanged text proxy remains about **2.1 ms**.

A separate fresh-module run recorded a first creation of **297 ms** and first full proxy of **154 ms**; warmed creation in that run was 180 ms. This is one startup sample, not a startup percentile.

The improvements come from reusing exact profiles for unchanged geometric groups, reusing constructed edges, and unifying shared boundaries of already-split text cells without another Boolean. Conservative aggregate bounds keep holes and tolerance-touching contours together. B-spline control hulls avoid expensive extrema searches. Repeated glyph outlines are reused within the current font configuration; native font setup and outline creation were already below 1 ms.

Caches retain only the latest group set in each sketch snapshot, are not serialized, and preserve preview/failure isolation. Grouping remains conservative: nearby geometry may rebuild together. Text translation/rotation does not yet reuse regions in text-local coordinates.

## First-proxy regression

The earlier **100 → 130 ms** observation came from separate runs. Attributing that increase to batched normalization was not supported by a controlled comparison.

Two WASM builds with identical surrounding code and inputs, differing only in sequential versus batched union, were tested in alternating order. Four initial interactions per build were excluded; 20 samples remained:

- Sequential: **129.5 ms** first proxy, **135.5 ms** p95.
- Batched: **131.1 ms** first proxy, **136.6 ms** p95.
- Both produced 424 curves, 1,153 points, 21 regions and 808 boundary samples.

The corresponding native first proxies measured **17.7 and 17.5 ms**. Intersection, face construction and boundary sampling stages were comparable. Batching reduced native union work from about **73 to 8 ms**; the new implementation removes that redundant Boolean entirely.

The historical 30 ms difference was **not reproduced** and its cause remains unestablished. This comparison does not prove there is no smaller difference; it does rule out treating the earlier unpaired result as evidence of a batching-induced 30 ms regression.

## Evidence and verification

Raw reports, generated under `reports/performance/`:

- Before: `2026-11-24T18-05-40-243Z-wasm-sketch.json`.
- After: `2026-11-24T18-23-20-655Z-wasm-sketch.json`.
- Fresh-module check: `2026-11-24T18-28-43-388Z-wasm-sketch.json`.
- Controlled WASM comparison: `2026-11-24-first-proxy-ab.json`.
- Native sequential/batched stages: `2026-11-24T18-10-42-065Z-native-sketch.json` / `2026-11-24T18-09-26-044Z-native-sketch.json`.
- Final native stages and reuse assertions: `2026-11-24T18-26-28-533Z-native-sketch.json`.

147 native API tests and 105 WASM sketch tests pass, including group merging/splitting, nested holes, construction changes, fitted splines, text reference volumes, previews and downstream extrusion. The full browser suite and web/desktop UI builds pass. All five opt-in performance scenarios pass in both runtimes. See [performance commands](performance.md) to repeat measurements; `--geometry-profile` enables native stage records.
