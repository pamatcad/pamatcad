# Scope

The Remove mode of `sketch.curves.modify`, shared by the editor, SDK and CLI.

# Intent

Remove the clicked portion of a sketch curve between intersections with existing geometry. Without interior intersections, remove the whole curve. Remain active in the editor for repeated clicks; Escape returns to selection.

# Inputs

Exactly one editable line, arc, circle, ellipse or spline in an open sketch. Projected geometry, unconverted text outlines and protected construction helpers cannot be targets. Other sketch curves, including ordinary construction curves and projections, supply boundaries without being modified. Protected spline control polygons, text frames and the target ellipse's own axes are not boundaries. Replacing an ellipse also removes its axis helpers.

# Parameters

Use `operation: { type: "remove", position: [x, y] }`. Position is a finite point in the sketch frame, using the same internal length units as sketch point coordinates. Choose the interval nearest this point. Coincident nearest intervals at an intersection are ambiguous and require another pick.

# Preview, results and effects

Use the existing preview flag and edit result. Remove the chosen interval and retain exact remaining curves, including construction status. The seam of a closed curve is not an intersection unless another curve meets it. A closed curve with only one intersection is one removable interval. The operation is atomic, including constraint solving and dimension-dependency validation.

# Topology and references

Reuse curve-edit replacement, endpoint reuse, unused-point cleanup and constraint/dimension cleanup. Unchanged geometry and its references remain intact. Changed curves receive new references; constraints and dimensions referencing removed geometry are reported and removed. Reject edits that would leave a surviving dimension dependent on a removed dimension. Periodic curves retain intervals crossing their parameter seam as one curve; nonperiodic closed splines may retain multiple exact, joined spans.

# Errors

Return `INVALID_PARAMETER` for a missing or multiple target, non-curve target, protected target, nonfinite position, ambiguous interval, or invalid resulting geometry. Failed requests leave committed state unchanged.

# Test cases

- Remove the middle and an end interval of a line intersected by two other lines; preserve both boundary curves, unrelated geometry and surviving endpoint references. Repeat with construction geometry and a projected boundary.
- Remove an isolated line or closed curve entirely, including its unused points. Keep neighboring curves and shared endpoints.
- Trim arcs, circles, ellipses and fitted/control splines against intersecting lines; preserve exact retained shapes. Cover closed-curve seam crossings, one intersection, tangency, rotated sketch frames and near-intersection picks.
- Reject point/multiple/projected/protected targets and a pick exactly at an intersection without mutating state. Preserve unrelated constraints; reject a trim whose removed dimension is referenced elsewhere.
- Preview without committing, cancel, repeat, finish/reopen and replay the same captured commands through the CLI. Compare exact regions and extrusion volume after trimming an overlong rectangle side.
- In the editor, use the ribbon and repeated curve clicks; verify empty picks, curve-over-point picking, Escape, document switching, the 16 px cursor badge and custom tooltip. Verify the refreshed tool icons retain theme roles and no native tooltips appear over their SVGs.

# History

2026-11-25: Implemented in the native/WASM core, generated protocol, SDK and editor. Verified curve families, seams, helper cleanup, protected geometry, preview/repeatability, CLI replay and rectangle extrusion volume; browser checks cover repeated picks, cursor, document switching and custom tooltips. Trimmed ellipses use exact rational splines; existing solid mass integration is approximate for these curves.
