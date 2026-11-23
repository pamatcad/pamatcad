# Sketches

A base, 2(3) drawings user as a base for most operations, however 3D sketches are not implemented yet.

# Switching to sketch workspace

A sketch can be created on any flat surface of a solid body or a construction geometry (e.g. solid face, construction plane). Sketch caches the construction plane (which later can be updated) so the sketch can be recalculated after the reference is lost, albeit with warning.

A screen orientation is remembered after the sketch is created, and returned after the sketch is complete or canceled.

A sketch icon appears near the gizmo in sketch mode, so the user can return to the initial sketch orientation after scene has been rotated.

For user convenience the origin (xy/xz/yz) planes become visible during sketch creation. Their labeled patches occupy positive quadrants, with a side length of one eighth of the shorter viewport dimension at the origin and an offset of one eighth of that side length. Size follows zoom and resize in both camera modes, with natural foreshortening. Hover and labels use the shared theme. The creation panel shows “Choose a construction plane or a planar solid face”.

# General UI considerations

## Interactions

Sketch elements are selected by clicking on them. In case when there are two geometries (two lines on one another, or two overlapping points), double-click opens a small popup listing all selectable geometries at sketch point, hovering over the list items highlights the geometry.

With no active command, the sketch is in selection mode. Completing geometry, applying a tool, or toggling the active ribbon button returns to selection. Escape discards the unfinished drawing or active tool without closing the sketch; in selection mode it clears the selection. Delete or Backspace removes selected geometry, constraints, or dimensions, except while editing text.

Dragging excludes the moving point and its coincident partners from snap targets. While a drag update is pending, retain the newest pointer position and always apply the release position. A click without movement only selects.

Dragging a line moves both endpoints together according to their constraints. Endpoint targets use the line and pointer positions at drag start; the endpoints and their coincident partners are excluded from snapping. Projected lines remain read-only.

Dragging a circle rim or arc edge first resizes it with its center held; arcs also prefer unchanged endpoint angles. Dragging an arc center prefers translation with unchanged radius and sweep. Permanent constraints take priority over these temporary preferences. Projected geometry remains read-only.

Drawing previews and dragging start immediately, with one update in flight and only the newest input waiting. Display completed previews during continued movement; enable Apply only for the current valid input. Completion uses the final input. Escape, tool changes, and document suspension invalidate pending previews.

Points are visible small circles. Constrained, partially constrained, unconstrained, explicitly fixed and projected geometry have distinct shared [palette colors](default_palette.md#viewport-and-user-colors). Selection overrides their color and doubles line width and point size. Construction geometry is presented as dotted lines. New geometry is visibly unconstrained before DOF results are available.

When a tool, constraint, or a geometry is selected, a part of tool window changes accordingly.

Every geometry displays live dimensions during creation - with an ability to navigate between editable dimensions via tab and entering a dimension value. Every dimension is a formula. 

Drawing starts with a canvas point. Editable dimensions appear beside the draft on the canvas; the tool window has no generic X/Y/width/height inputs. Enter completes the geometry using the entered dimensions.

Dimension labels and numeric edit fields show up to four decimal places, trimming trailing zeros. Compact fields and high-contrast numbers follow the shared palette. Formatting preserves formulas and the full stored precision when a value is accepted unchanged.

A selection of a geometry highlights shared constraints (imagine three lines connected in sequence, if one selects a first and a second line, a coincident constraint should be highlighted near where lines meet).

If sketch creates a closed region, then this region should be highlighted.

## Tool window

The Sketch workbench ribbon contains Geometry, Constraints, and Tools sections, each with two rows of icons. Tool variants and parameters remain in the tool window, including a single Geometry row with Normal and Construction icons. These set the selected geometry mode, or the drawing mode when nothing is selected. Creating or editing a sketch activates this workbench; Finish or Cancel returns to Solid. Switching document tabs restores each document's workbench and active tool.

A tool window appears in the sketch mode, some of the interface is shared and some is action-dependent. The interface is defined in sections:

- Geometry mode: normal / construction icons with explanatory tooltips
- Recompute automatically checkbox and a status panel (constrained / unconstrained / dof), for the selected object or the whole sketch. Show Recompute only when automatic recompute is off.
- Highlight: caption and one row of icons for none / constrained / partially constrained / unconstrained
- Currently selected tool configurations, see below
- Display: caption and one row of icon toggles for lines, points, constraints, dimensions, construction geometry, projections
- Snap: caption and one row of icons for geometry snapping and grid snapping
- Cancel sketch / Finish sketch

Highlight defaults to None. Choosing a category highlights matching geometry in the shared green color while other geometry keeps its normal colors. Constrained includes fixed geometry; orange selection takes priority. Clicking the active category again, or None, clears highlighting.

Sketches are auto-named and can be renamed later. The tool window has no name field, help paragraph, or References section; retain the plane-change implementation for future use.

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

Complex geometries are collections of constrained simpler primitives. A rectangle consists of four ordinary lines, with their endpoints joined by pairwise coincidence constraints; each line remains independently selectable and editable. A slot consists of two arcs, two side lines, and a construction line between the arc centers. Centered rectangles also have two construction diagonals and a midpoint. Slots have a construction midpoint on their centerline. These helpers remain selectable and constrained to the boundary geometry.

Center-based arcs use three clicks: center, start point, and sweep endpoint. Three-point arcs use the two endpoints first, then a point on the arc. Both preview the final arc under the cursor; an angle becomes driving only when explicitly entered.

Three-point slots use the two outermost tips, then a radius point; center-to-center slots use the two cap centers, then a radius point. Radius is the perpendicular distance to the selected axis. For outer-tip slots, the diameter must be less than the overall length. Center-and-line slots use the midpoint, one cap center, then a radius point. Every new slot starts with a small viewport-relative preview radius, capped relative to its axis length, without inheriting another tool’s radius. Cursor movement sets perpendicular radius; an explicitly entered formula overrides it. Rectangle, arc, and slot variants use icon buttons with tooltips.

# Projections

Any solid geometry can be projected to a sketch; when using "project" the user can select points, edges or faces of any existing geometry. Similarly to the sketch plane, the geometry is cached. Lost geometry can be removed or updated in a workflow.

Projection is orthogonal along the sketch normal; selecting a face projects its boundary edges. Projected geometry is linked and read-only. If its source disappears, the cached geometry remains usable with a warning until the reference is repaired or removed.

# Dimensions

The Dimension tool (D) infers radius from a circle/arc, length from a line, distance from two points or a point and line, perpendicular distance from parallel lines, and angle from nonparallel lines. A driving parallel-line distance also maintains parallelism; removing it removes that equation. Cursor placement chooses the angle sector. Right-click offers other applicable measurements (diameter, horizontal/vertical distance, ellipse radii, orientation/span).

Click to place the preview, enter a formula, and press Enter; Escape cancels. Dimensions show extension lines, arrows and values in the sketch. Drag their lines or labels to reposition annotations without changing geometry or DOF. Placement is stored in sketch coordinates and survives Finish/reopen; Cancel restores it. Double-click edits a driving formula; right-click handles naming and driving/driven mode.

Dimensions can be created during any drawing of a geometry, or later (by using dimension tool). Dimensions use the shared formula solver, that can compute lengths or reference other dimensions (like dimension133, by name, or from other sketch - sketch23dimension444, or sketches[main]dimension[width]). Dimensions can be removed at any time, double-clicking a dimension allows to change the value, and right-click allows to rename it via a popup menu.

Cross-sketch formula dependencies must be acyclic. Within a sketch, driving expressions that reference driven measurements are solved simultaneously with the geometric constraints. References bind to stable IDs, so renaming does not break existing formulas; deleting a referenced dimension reports a dependency error.

Dimension can be driving or driven; driving dimensions are used in computation, driven are not, and driven are created when adding a driving dimension would over-constrain the sketch. Right-clicking a dimension can switch it from diving to driven and vice versa if this does not overconstrain the sketch.

Dimensions can reference driven dimensions during computation, for example this approach should be possible: create a fixed length line, and add two points, lets name line ends A and B, and points C and D. Create a driven dimension between D and B; crate a driving dimension between A and C, that references the first one. Create a driving dimension between C and D, that references the second one. Now the C and D should be evently distributed and all three dimensions should be equal.

# Constrained and unconstrained sketches

Constrained and unconstrained sketches can be used in the same way be other tools and commands, as long as they create closed regions.
