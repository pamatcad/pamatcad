# Sketches

A base, 2(3) drawings user as a base for most operations, however 3D sketches are not implemented yet.

# Switching to sketch workspace

A sketch can be created on any flat surface of a solid body or a construction geometry (e.g. solid face, construction plane). Sketch caches the construction plane (which later can be updated) so the sketch can be recalculated after the reference is lost, albeit with warning.

A screen orientation is remembered after the sketch is created, and returned after the sketch is complete or canceled.

A sketch icon appears near the gizmo in sketch mode, so the user can return to the initial sketch orientation after scene has been rotated.

For user convenience the origin (xy/xz/yz) planes become visible during sketch creation. 

# General UI considerations

## Interactions

Sketch elements are selected by clicking on them. In case when there are two geometries (two lines on one another, or two overlapping points), double-click opens a small popup listing all selectable geometries at sketch point, hovering over the list items highlights the geometry.

With no active command, the sketch is in selection mode. Completing geometry, applying a tool, or toggling the active ribbon button returns to selection. Escape discards the unfinished drawing or active tool without closing the sketch; in selection mode it clears the selection. Delete or Backspace removes selected geometry, constraints, or dimensions, except while editing text.

Dragging excludes the moving point and its coincident partners from snap targets. While a drag update is pending, retain the newest pointer position and always apply the release position. A click without movement only selects.

Dragging a line moves both endpoints together according to their constraints. Endpoint targets use the line and pointer positions at drag start; the endpoints and their coincident partners are excluded from snapping. Projected lines remain read-only.

Drawing previews and dragging start immediately, with one update in flight and only the newest input waiting. Display completed previews during continued movement; enable Apply only for the current valid input. Completion uses the final input. Escape, tool changes, and document suspension invalidate pending previews.

Points are visible small circles. Constrained, unconstrained and projected geometry have different colors; additionally, construction geometry is presented as dotted lines. 

When a tool, constraint, or a geometry is selected, a part of tool window changes accordingly.

Every geometry displays live dimensions during creation - with an ability to navigate between editable dimensions via tab and entering a dimension value. Every dimension is a formula. 

Drawing starts with a canvas point. Editable dimensions appear beside the draft on the canvas; the tool window has no generic X/Y/width/height inputs. Enter completes the geometry using the entered dimensions.

A selection of a geometry highlights shared constraints (imagine three lines connected in sequence, if one selects a first and a second line, a coincident constraint should be highlighted near where lines meet).

If sketch creates a closed region, then this region should be highlighted.

## Tool window

The Sketch workbench ribbon contains Geometry, Constraints, and Tools sections, each with two rows of icons. Tool variants and parameters remain in the tool window, including the normal/construction selector and construction toggle. Creating or editing a sketch activates this workbench; Finish or Cancel returns to Solid. Switching document tabs restores each document's workbench and active tool.

A tool window appears in the sketch mode, some of the interface is shared and some is action-dependent. The interface is defined in sections:

- Geometry mode: normal / construction
- Panel displaying compute status: a toggle to recompute automatically, a button to recompute on demand, and a current status (constrained / unconstrained / dof), for a currently selected object or a sketch in whole if nothing is selected.
- Highlight: constrained / partially constrained / unconstrained
- Currently selected tool configurations, see below
- Display toggles: lines, points, constraints, dimensions, construction geometry, projections
- Edit options: snap, snap to grid
- Cancel sketch / Finish sketch

## Tool configurations

Icon selectors

- Rectangle: 2 point rectangle; rectangle at angle (3 points); centered rectangle
- Circle: center point; two point and radius; three point; 2 tangent and radius; 3 tangent 
- Arc: center, point and angle; 3 point
- Ellipse: center, width and height; rectangle
- Slot: 3 point slot; center and line slot, center to center slot
- Spline: fit point; control point
- Text: font, font weight, font size, alignment (vertical / horizontal), guide (straight or pick a guideline)
- Edit/Offset: 1 sided, 2 sided (symmetric or independent), 1 or 2 lengths accordingly
- Edit/Rounding: one radius in the tool window for all selected geometry
- Edit/Scale: one scale rate in the tool window, a draggable arrow in a viewpoint
- Edit/Move: draggable arrows in a viewport (rotate and move), a button to select a pivot point and copy instead of move in the tool window

## Tool annotations

- Constraints
  - Symmetric: two points symmetric to a line
- Edit
  - Split: basically, insert point at crossing point and split curves or lines

# Implementation details

Only non-construction, closed geometry creates valid regions to use with commands.  

Dimensions should be accessible throughout the whole document. Dimensions could be referenced directly (sketch5 -> dimension31, note that dimensions may be removed without re-enumerating all following dimensions, so it's not just and indexed array), or by sketch and dimension names (something line scene.sketches.findByName and sketch.dimensions.findByName).

Complex geometries are collections of constrained simpler primitives. A rectangle consists of four ordinary lines, with their endpoints joined by pairwise coincidence constraints; each line remains independently selectable and editable. A slot consists of two arcs, two side lines, and a construction line between the arc centers. A three-point slot uses two arc centers and a third point defining the radius.

# Projections

Any solid geometry can be projected to a sketch; when using "project" the user can select points, edges or faces of any existing geometry. Similarly to the sketch plane, the geometry is cached. Lost geometry can be removed or updated in a workflow.

Projection is orthogonal along the sketch normal; selecting a face projects its boundary edges. Projected geometry is linked and read-only. If its source disappears, the cached geometry remains usable with a warning until the reference is repaired or removed.

# Dimensions

Dimensions can be created during any drawing of a geometry, or later (by using dimension tool). Dimensions use the shared formula solver, that can compute lengths or reference other dimensions (like dimension133, by name, or from other sketch - sketch23dimension444, or sketches[main]dimension[width]). Dimensions can be removed at any time, double-clicking a dimension allows to change the value, and right-click allows to rename it via a popup menu.

Cross-sketch formula dependencies must be acyclic. Within a sketch, driving expressions that reference driven measurements are solved simultaneously with the geometric constraints. References bind to stable IDs, so renaming does not break existing formulas; deleting a referenced dimension reports a dependency error.

Dimension can be driving or driven; driving dimensions are used in computation, driven are not, and driven are created when adding a driving dimension would over-constrain the sketch. Right-clicking a dimension can switch it from diving to driven and vice versa if this does not overconstrain the sketch.

Dimensions can reference driven dimensions during computation, for example this approach should be possible: create a fixed length line, and add two points, lets name line ends A and B, and points C and D. Create a driven dimension between D and B; crate a driving dimension between A and C, that references the first one. Create a driving dimension between C and D, that references the second one. Now the C and D should be evently distributed and all three dimensions should be equal.

# Constrained and unconstrained sketches

Constrained and unconstrained sketches can be used in the same way be other tools and commands, as long as they create closed regions.
