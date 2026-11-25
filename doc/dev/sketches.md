# Sketch implementation

The [UI specification](../ui/sketches.md), [command contract](../api/command/sketch/edit/spec.md), and [SDK guide](../../sdk/javascript/docs/sketches.md) describe the public behavior.

## Responsibilities

- `src/core/src/sketch/`: stable entities, compound constructors, constraints, dimensions, projections, and region identities. Rectangles and slots contain ordinary curves. Text objects own exact outline curves for regions; conversion releases these as ordinary editable geometry.
- `src/core/src/engine/sketching.rs`: transactional working copies, dependency validation, preview overlays, Finish/Cancel, and timeline replay. Failed edits publish nothing. Finished edits replay downstream commands through the shared modeling interface and preserve surviving feature/body IDs.
- `native/sketch/`: PlaneGCS adapter. The shared formula parser produces an expression tree; its derivative bytecode becomes solver equations, including driven measurements referenced by driving formulas. Fixed variables are excluded from the unknown set. Residuals are checked after solving. The Jacobian nullspace supplies total freedom and the rank of each entity’s restricted freedom, including constituent points.
- `native/occt/sketch.cpp`: exact conic/B-spline edges, splitting, planar regions, projection, offsets, fillets, and text-contour normalization. Tessellation occurs only for explicit display requests. Regions retain source-edge provenance; multiple fragments of one source edge contribute to its extrusion face query.
- `apps/editor/src/tools/sketch.ts`: the working sketch controller. `sketch-geometry.ts` resolves interactive construction points into primitive parameters; geometric constraints remain in the core. Templates and SVG icons are separate assets. The viewport owns picking and display, using semantic theme colors.

Entity IDs increase monotonically within a sketch; deleted IDs are not reused. Region keys derive from oriented source boundaries. Indistinguishable regions report ambiguity instead of choosing by position. Display indices are never used as persistent sketch IDs.

Straight-text frames use five shared points and six construction lines. Shaped advances define horizontal bounds; font ascender/descender and line spacing define vertical bounds. Seven intrinsic equations fix size and rectangular shape, leaving translation and rotation free. After solving, the rigid frame pose transforms exact glyph control points and refreshes their internal fixed values. Content rebuilds replace glyphs while retaining frame references; conversion removes ownership and intrinsic equations. Empty text has zero width; its collapsed construction edges are sampled directly and remain valid after conversion. Ordinary geometry retains its degeneracy checks.

## Constraint domains

Coincidence uses points; point-on-curve supports lines and conics. Horizontal/vertical constraints accept a line or two points. Parallel, perpendicular, collinear and midpoint use lines. Equality supports line lengths or circular radii; concentricity uses conic centers. Tangency supports line/circle/arc combinations. At a coincident line/arc endpoint, use the perpendicular radius/line equation to avoid a singular distance-to-circle equation during dragging. Symmetry reflects two points across a line. Invalid combinations report a parameter error.

Lengths measure lines; distances measure point pairs, point-to-infinite-line perpendiculars, or parallel-line separation. A driving line-pair distance owns a parallelism equation; nonparallel line-pair distances are invalid. Radius/diameter measure circles/arcs; major/minor radius measure ellipses. Angles measure two lines, one line’s orientation, an arc’s span, or an ellipse’s orientation. Unitless expression results use the scene’s units; numeric API values retain mm/degree semantics.

## References and editing

`src/core/src/sketch/solver/components.rs` partitions compiled equations by shared unknown variables before PlaneGCS diagnosis and the Jacobian/nullspace calculations. Intrinsic geometry, formula measurements and temporary cursor equations participate; shared fixed coordinates do not connect components. Total and per-entity DOF sum the independent components' restricted ranks. Constant-only equations still undergo residual checks. Each solve rebuilds the partition and reuses an untargeted component only when its equations, parameter values, fixed mask and freedom groups match exactly. Changed geometry recomputes DOF; cursor equations never enter the permanent cache. Only the latest accepted component results are retained, shared immutably across transaction snapshots. See [Performance testing](performance.md) for opt-in stage measurements and reuse counts.

Exact sketch regions, boundary samples and display curves have transient caches keyed by their actual inputs, including source identities, coordinates, construction membership and the support frame. Failed edits and preview replacement cannot mutate another snapshot's entries; caches are not serialized. `getProxy()` returns complete current regions; `getProxy({ regions: false })` skips exact reconstruction and returns `regions: null`. Live drawing and dragging use this geometry-only path, clearing stale fills until commit/release requests full regions. Both reads settle before the next update, and interaction changes reject stale responses. Text normalization reuses constructed edges, groups disconnected contours, then unifies the shared boundaries of already-split filled cells without another Boolean. Repeated glyph outlines are reused within the current font configuration. Straight display lines use endpoints directly; selected-curve encoding uses indexed lookup.

Region grouping merges conservative aggregate bounds to a fixed point, retaining nested contours and tolerance-touching geometry together. B-spline control hulls avoid numerical extrema searches. Exact input keys reuse unchanged groups; changed membership, coordinates, construction or support rebuild the affected groups. Combined profiles retain the common source-based ordering and ambiguity checks. Only the latest group set is cached per sketch snapshot.

Normalized glyph curves have a separate engine-owned cache shared across sketches and preview snapshots. Exact scaled outline coordinates form the key; font names and glyph IDs alone are insufficient. Curves are cached in local coordinates without model references, then placed and assigned fresh entities identically on hits and misses. Conservative aggregate bounds route overlapping glyphs through joint normalization of their original contours. The cache retains at most 8 MiB of accounted entry storage and 4096 entries, evicts least-recently-used entries, bypasses oversized results, and is never serialized. This budget includes curve/key capacities and a map-node allowance, not a measurement of total allocator memory. Closing the engine releases the cache; closing a scene permits reuse by other scenes.

Point dragging uses temporary solver goals. It first holds the requested corner position while minimizing other parameter movement; if permanent constraints prevent reaching it, it finds an attainable position and preserves that target during the remaining minimization. Coincident endpoints use a canonical target. Residuals and DOF are evaluated from permanent constraints only. The editor excludes the moving coincidence group from snapping and coalesces pending pointer updates through release.

Temporary cursor and position-preference equations use negative tags and `driving=false` in PlaneGCS: they remain auxiliary objectives but do not enter its permanent-constraint redundancy proof. This allows constrained motion with redundant relations even when the cursor itself is unreachable. All permanent residuals remain checked after solving.

Line dragging expands to two absolute endpoint targets in the same solver call. The adapter accepts multiple targets, canonicalizes coincident endpoints, and rejects conflicting targets for the same vertex. The editor retains the starting endpoints through the gesture instead of accumulating deltas between responses.

Circle/arc rim dragging adds temporary cursor variables and a point-on-circle equation. It first pins the center and arc endpoint angles, then falls back to the shared constrained drag solve. Arc center dragging prefers unchanged radius and sweep. Temporary variables/equations do not contribute to reported DOF or persistent constraints.

`sketch-dimensions.ts` infers measurements and lays out annotations; the core remains authoritative on commit. `DimensionParameters.annotation.position` is sketch-local display metadata. Annotation-only updates bypass solving, geometry revisions and proxy invalidation. Two-line `angleBranch` fixes the chosen measurement sector independently of annotation position: for signed angle θ, direct/reversed/supplementary/reversedSupplementary measure θ, −θ, 180°−θ, and 180°+θ respectively.

The sketch controller shares one update loop for previews and dragging, without a timer delay. Input revisions determine readiness; a separate interaction revision invalidates results on cancellation, tool changes, completion, or suspension. Each preview captures its construction inputs before formula evaluation and waits for both state and proxy reads before starting the newest queued update.

Formula symbols bind to dimension IDs. Renaming preserves bindings. Cross-sketch dependencies are solved in dependency order; cycles and deletion of referenced dimensions fail. Feature formulas carry the same serialized dependency metadata, so deletion checks do not need operation-specific code.

Support frames and projected geometry are cached model data. Failed resolution preserves the cache and reports a warning. Projection repair retains IDs only when the replacement has compatible topology; otherwise callers remove and recreate it explicitly. Edge/vertex references are revision-bound. Face inputs use the core’s face references.

Split/rounding return replacement curves and explicitly list removed constraints/dimensions. Offset creates independent curves. Copy duplicates selected geometry and internal relations with new IDs; references outside the copied set remain external. With automatic recompute, transforms fail atomically if remaining constraints prevent the requested result. Preview copies are session-local and discarded on scene mutation or explicit cancellation.

## Dependencies and verification

CMake downloads the pinned PlaneGCS, Eigen and Boost sources in `native/sketch/CMakeLists.txt`. The same adapter compiles for native and WASM. Rustybuzz/ttf-parser versions are locked by Cargo. Bundled Roboto and its OFL license are in `native/sketch/fonts/`; callers can supply another OpenType/TrueType font or collection as base64 with a face index. Editable text retains these bytes and its evaluated size formula.

```sh
npm run test:api
npm run build:wasm
PAMATCAD_TEST_RUNTIME=wasm node --test tests/dist/api/sketch/*.js
npm run build:web
npm run test:editor:web
npm run test:editor:desktop
```

The same sketch scenarios exercise native and WASM dispatchers. The browser workflow checks plane selection, formula inputs, geometry creation, display controls, camera restoration, reopening/cancellation, and downstream extrusion. `PAMATCAD_EDITOR_TEST=sketch npm run test:editor:web` runs that editor workflow alone.
