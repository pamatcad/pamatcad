# Performance testing

Performance scenarios live in `tests/performance/`, outside the ordinary API and editor suites. They run only when explicitly requested for performance testing or optimization. Normal feature implementation does not require running them or collecting before/after timings.

```sh
npm run test:performance
npm run test:performance -- --runtime wasm
npm run test:performance -- --test-name-pattern="100 slots"
npm run test:performance -- --solver-profile --test-name-pattern="100 slots"
npm run test:performance -- --geometry-profile --test-name-pattern="15-letter|100 slots"
```

The dedicated command builds the selected runtime and runs scenarios sequentially. Native uses the release core over WebSocket; WASM uses the production module in Node. These measure SDK round trips, excluding browser worker transfer and viewport rendering. Normal `npm test`, SDK and editor test commands do not discover this suite.

The initial scenarios drag a slot midpoint in sketches containing 10 or 100 disjoint slots, and drag a text block containing hundreds of outline curves. Setup and compilation are excluded from timings. Each scenario records the first interaction, three warm-up interactions, then 20 measured interactions. Drag, state retrieval, geometry-only proxy retrieval, the live API cycle, final full proxy retrieval and the complete cycle including that final read are measured separately; results contain raw samples, median and p95, geometry counts, runtime/build, machine and Git revision metadata.

A separate 10-slot scenario connects all radii with equality constraints to exercise a single coupled component. Profiling also checks the expected component counts; ordinary API regressions check independent geometry and DOF without timing thresholds.

The text-creation scenario measures `PerformanceTest` (15 letters, bundled Roboto, 10 mm) in fresh scenes, recording creation, first proxy and repeated unchanged proxy separately under `creationResults`. Scene setup/cleanup and validation are outside the timed intervals. Solver profiling checks that dragging one of 100 independent slots reuses the other 99 components; connected slots remain one solve.

The glyph-cache scenario creates `text so long and so on and so forth`, then changes it to `text so forth and so on and so long` at 10 mm. Both must retain 39 regions. Each performance scenario starts a fresh engine, including a separate WASM module instance: the first creation has a cold glyph cache; subsequent scenes reuse it. Reports distinguish first creation, warmed creation, content editing, and first/repeated full proxies. Native geometry profiling also records `glyphCacheHits`, `glyphCacheMisses` and `overlapGroups`; overlapping groups still undergo joint normalization. These scenarios remain opt-in.

See the [glyph-cache measurements](performance-glyph-cache.md) for the controlled before/after comparison and validation results.

JSON results are saved under `reports/performance/`; their paths are printed by the suite. Compare the same scenario, runtime, build and machine. There are no timing pass/fail thresholds yet; the suite checks that operations succeed, drag targets are reached and regions remain valid. Set explicit budgets when undertaking performance work, using these baselines. Do not silently update budgets to accept a regression.

`--solver-profile` adds native slot-drag stage timings and component sizes to the report (first interaction, warm-ups, then samples). Diagnosis includes PlaneGCS initialization; solve includes applying its result. Jacobian and entity/total DOF are separate. Profiling is opt-in, adds measurement overhead, and excludes response serialization from the internal solver total. Direct native callers can enable the same JSON stderr events with `PAMATCAD_SKETCH_PROFILE=1`.

2026-11-24 optimization measurements: on the same machine, warmed WASM 15-letter creation fell from 428 to 217 ms, repeated unchanged proxies from 100 to 2 ms, and 100-slot drag solving from 26 to 12 ms. The long-text geometry-only proxy measured 9 ms (20 ms for drag/state/live proxy); its final full proxy still cost 165 ms. A fresh full proxy after 15-letter creation cost 130 ms versus 100 ms before batching, so the improvement applies to creation and live/repeated reads, not fresh full-region reconstruction. The focused final report is `reports/performance/2026-11-24T17-22-52-100Z-wasm-sketch.json`; the native report is `reports/performance/2026-11-24T17-21-50-775Z-native-sketch.json`. An earlier final WASM run was affected by heavy macOS indexing load and should not be compared directly with the baseline.

`--geometry-profile` records native text setup/outlines/normalization, OCCT intersection/face construction/boundary sampling, and region-group reuse. Profiling adds overhead and remains separate from unprofiled WASM request measurements. Independent-slot scenarios verify that only the changed group rebuilds after the initial full proxy. See [Text and region optimization report](performance-text-regions.md) for the controlled first-proxy comparison and the correction to the earlier attribution.
