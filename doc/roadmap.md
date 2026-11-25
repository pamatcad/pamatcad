# Roadmap

## Sketch solver and proxy performance (deferred)

Start with repeated dragging in the 100-slot scenario, measuring whole-sketch preparation, changed-component solving and degree-of-freedom (DOF) analysis separately. Use those measurements to choose the implementation order. Keep performance scenarios in the [opt-in suite](dev/performance.md).

1. Retain the compiled equation graph between edits. Update parameter values during dragging; rebuild affected mappings, equations and component partitions when geometry, constraints or dependencies change.
2. Reduce DOF-analysis overhead. Reuse buffers and structural information, and handle simple cases directly. Preserve detection of rank changes at singular configurations; do not blindly reuse previous DOF values.
3. Reduce copying and allocation during live updates. Share immutable data and copy only modified state while preserving transactional edits and preview isolation. Include bookkeeping for fixed text outlines.
4. Optimize large connected components. Profile PlaneGCS diagnosis separately from solving; investigate Jacobian sparsity and reusable solver preparation. Cover both independent slots and slots connected by constraints; component caching alone does not address one large connected system.

Investigate full-region/proxy reconstruction separately. The measured text's first full proxy still took about 286 ms after glyph caching; faster solving alone will not remove that cost. See the [glyph-cache comparison](dev/performance-glyph-cache.md).

## M5 - web apps

Goal: user should be able to take a save file and product a web app to configure a product

- CAD tool: gear and tooth generator
- demo: gridfinity box generator
- demo: planetary gearbox generator
- demo: cycloidal drive gearbox generator
- demo: harmonic drive gearbox generator
- process: "save as web page" from editor
- process: "compile web page" from cli
- settings: changeable parameters and descriptions, what export formats are supported, what can be exproted
- website (link to pamatcad.com)

## M4 - basic CAD

Goal: basic CAD operations

- construction plane, offset, tangent, at angle
- axis to face at point
- sketch patterns
- feature and body patterns
- fillets and chamfers
- body split
- STL export
- sweep

## More CAD

Parameters
Revolve
Boolean operations

## M3 - branching timeline

Goal: establish branching timelines early

- branching timeline, switching between branches
- timeline recalculation, timeline dependencies, cached geometry and error state

- 
- undo/redo stack
- setting: sketch-dimension-precision
- 3d sketches
- popovers and tooltips
- icons where needed
- mcp
- settings
- keyboard shortcuts
- sketch: lost geometry
- editable timeline, sketches
- timeline
- saving
- sketches