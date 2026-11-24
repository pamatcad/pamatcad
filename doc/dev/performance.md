# Performance testing

Performance scenarios live in `tests/performance/`, outside the ordinary API and editor suites. They run only when explicitly requested for performance testing or optimization. Normal feature implementation does not require running them or collecting before/after timings.

```sh
npm run test:performance
npm run test:performance -- --runtime wasm
npm run test:performance -- --test-name-pattern="100 slots"
```

The dedicated command builds the selected runtime and runs scenarios sequentially. Native uses the release core over WebSocket; WASM uses the production module in Node. These measure SDK round trips, excluding browser worker transfer and viewport rendering. Normal `npm test`, SDK and editor test commands do not discover this suite.

The initial scenarios drag a slot midpoint in sketches containing 10 or 100 disjoint slots, and drag a text block containing hundreds of outline curves. Setup and compilation are excluded from timings. Each scenario records the first interaction, three warm-up interactions, then 20 measured interactions. Drag, state retrieval, full proxy retrieval and the complete API cycle are measured separately; results contain raw samples, median and p95, geometry counts, runtime/build, machine and Git revision metadata.

JSON results are saved under `reports/performance/`; their paths are printed by the suite. Compare the same scenario, runtime, build and machine. There are no timing pass/fail thresholds yet; the suite checks that operations succeed, drag targets are reached and regions remain valid. Set explicit budgets when undertaking performance work, using these baselines. Do not silently update budgets to accept a regression.
