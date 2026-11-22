# Name
Sketch editing

# Short Description
Create and edit constrained planar geometry, dimensions, and projected references.

# Scope
Planar sketches in a three-dimensional scene. The editor behavior is defined in [Sketches](../../../../ui/sketches.md).

# Description
Sketches combine independently addressable geometry, geometric constraints, and formula-based dimensions. Closed non-construction geometry produces selectable regions for modeling commands. Underconstrained sketches are valid.

# Inputs
A construction plane or planar solid face defines the sketch frame. Geometry coordinates are local to that frame. References must belong to the specified scene and sketch unless explicitly used as external projections or dimension dependencies.

# Parameters
Geometry constructors support points, lines, rectangles, circles, arcs, ellipses, slots, fit/control-point splines, and outlined text. Rectangle and slot constructors create ordinary constituent curves and constraints. Construction geometry is excluded from region boundaries.

Constraints include coincidence, point-on-curve, fixation, equality, concentricity, midpoint, parallelism, perpendicularity, tangency, horizontal/vertical orientation, symmetry, and collinearity. Dimensions measure lengths, distances, coordinates, radii, diameters, and angles. Driving dimensions add equations; driven dimensions measure solved geometry. Redundant driving dimensions become driven; conflicting values fail without changing the working sketch.

Formulas accept numbers and expressions. Existing numeric inputs retain millimetre/degree semantics; unitless expressions use scene units. Named references bind to stable dimension IDs. Cross-sketch dependencies are acyclic. Same-sketch measurement references enter the simultaneous solve. Scale factors are dimensionless. Ellipse major/minor radii and arc spans are dimensionable. See [Implementation](../../../../dev/sketches.md) for valid constraint combinations and solver details.

Editing supports removal, split at intersections, offset, rounding, scaling, move/rotate/copy, and projection. Three-point slots take two cap centers and a radius point. Other straight-slot constructors specify the centerline and width directly or from a center and extent. Circle/arc constructions with multiple solutions use the supplied point/side to select a branch. Face projections use boundary edges, projected orthogonally along the sketch normal.

# Preview, results and effects
Creation and reopening use a working sketch. Mutations return entity references and solve diagnostics; rendering is requested separately through `sketch.getProxy`. Recompute may be automatic or explicit; Finish performs a final solve. Finish commits one sketch entry and recomputes dependent features; Cancel discards the working copy. Open sketches may be finished but provide no bounded regions. Failed mutations preserve the previous valid working state.

# Topology and references
IDs are stable and never renumbered after deletion. Composite geometry retains independently selectable constituent entities. Region boundaries retain their source curve identities. Split or merged regions require explicit resolution when a previous selection becomes ambiguous. Cached support frames and projections remain available with warnings when references are lost; repair replaces the source explicitly.

# Errors
Reject nonfinite/degenerate geometry, invalid references, conflicting constraints, incompatible formula units, unresolved or cyclic dimension dependencies, ambiguous names/regions, nonplanar supports, and edits outside an active working sketch. Solver failure must not silently accept unsatisfied equations.

# Test cases
- Construct and constrain a rectangle, change its width formula, and extrude the updated region. Verify constituent line IDs and a single sketch timeline entry.
- Add/remove geometry and dimensions; verify names resolve stable IDs and deletion does not renumber survivors. Renaming preserves bound formulas; deleting a dependency reports an error.
- Fix a line AB; constrain C and D to AB in A–C–D–B order. Define DB as driven, AC from DB, and CD from AC. Verify equal thirds before and after changing AB.
- Verify a redundant dimension becomes driven, a contradictory driving dimension fails atomically, and driven-to-driving conversion succeeds only when consistent.
- Verify selected and whole-sketch freedom, underconstrained dragging, manual recompute, cancellation, and reopening a completed sketch.
- Exercise each rectangle, circle, arc, ellipse, slot, spline and text constructor; verify exact closed profiles can be extruded and construction curves cannot create regions.
- Import a font and create aligned construction text on an anchored guideline. Verify exclusion from regions, conversion to ordinary geometry, and atomic rejection when text exceeds the guideline.
- Exercise geometric constraints with perturbed coordinates, including tangency, symmetry, and point-on-curve; verify residuals and repeatability.
- Verify intersecting loops, nested holes, disconnected regions, open chains, and coincident boundaries, including general-profile extrusion and source-edge references.
- Exercise split, delete, offset, rounding, scale, move/rotate and copy, preserving unaffected IDs and constraints. Transforms blocked by orientation constraints must fail atomically; removing the blocking constraint permits the transform.
- Project points, edges and face boundaries onto rotated planes; remove/repair source references and verify cached geometry, warnings and continued extrusion.
- Reference dimensions across sketches and solid features; verify dependency recomputation, renamed references, cycle rejection, and failed-recompute recovery.
- Verify native/WASM agreement for solving, formulas, geometry, diagnostics and region identities.
- In the editor verify support-plane selection, camera restoration, sketch-view button, tool variants, live formula dimensions and Tab navigation, overlap picking, constraints, all display toggles, snapping, Finish and Cancel.
- Verify the Sketch ribbon's Geometry, Constraints, and Tools sections, per-document workbench/tool restoration, applying a constraint through the ribbon, and deleting selected geometry, constraints, and dimensions with Delete/Backspace. Construction controls stay in the tool window.
- Verify implicit selection on entry and after geometry completion, tool application, Escape, and toggling an active ribbon tool. Escape preserves completed geometry and the open sketch, invalidates pending previews, and discards only the unfinished drawing. Inputs, dialogs, and console text retain normal deletion behavior. Live formula dimensions appear beside the draft, support Tab/Shift-Tab and Enter, follow camera changes, and survive document switching; no generic coordinate/size fields or Select/Delete commands appear in the tool window/ribbon.

# History
2026-11-22: Implemented the planar sketch model, shared native/WASM solver, SDK commands, editor workspace, projections, exact regions, and editing tools. Verified with 72 native API tests, 30 WASM sketch tests, the full browser suite, and the desktop smoke workflow.
