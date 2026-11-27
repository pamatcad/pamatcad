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

Double-click an unambiguous curve or ordinary joined endpoint to select its connected component; Shift adds it to the selection. Include branches, defining points and internal construction helpers, so slots, rectangles, line chains and connected splines can move together. Follow shared/touching endpoints (within 1e-7 mm), Coincident, Point-on-curve and Midpoint relationships; crossings without a junction and constraints such as Equal or Parallel do not join components. Hidden helpers still participate. Distinct overlapping targets retain the popup, even within one component, and choosing a row selects only that item. A unique spline fit point with its own curves/handles retains its handle-mode toggle; unrelated overlapping geometry opens the popup. Dimension, text and offset double-click editing keeps priority.

With no active command, the sketch is in selection mode. Geometry, tools, and constraints remain active after each application. Completing geometry resets its construction points and typed dimensions while retaining the tool variant and construction mode. Applying an editing tool clears its operand selection. Escape discards the unfinished drawing or active command without closing the sketch; in selection mode it clears the selection. Choosing another command replaces the current one, and clicking its active ribbon button returns to selection. Delete or Backspace removes selected geometry, constraints, or dimensions, except while editing text.

The viewport uses the standard arrow in selection mode, a small hairline crosshair for drawing, and the standard arrow for editing tools and constraints. Active commands add a small outline symbol without filled geometry or vertex dots; variants share their command's symbol. Constraint ribbon and cursor icons use graphite; Horizontal and Vertical include H and V, and Collinear uses a longer graphite line and a shorter geometry-highlight line on the same axis. Cursors and symbols follow the active document and disappear over panels, inputs, the navigation cube, and during camera navigation.

Constraints can be activated before picking geometry. With preselection, the ribbon enables constraints whose operand types and counts are compatible, including incomplete selections. Complete selections apply immediately. In active constraint mode, click compatible geometry without Shift; Fix applies to each clicked item, while multi-object constraints apply when all required operands are collected. Each application starts a fresh selection. Clicking a pending operand again removes it; clicking empty space clears pending operands. Invalid picks do not replace them. Solver failures retain the mode and operands for correction, and duplicates retain the existing constraint.

Remove acts on each clicked curve portion between intersections and stays active; without intersections it removes the whole curve. It has no Apply button. Escape returns to selection. See [Remove curve intervals](../api/command/sketch/edit/remove.md) for supported geometry and boundary rules. Its ribbon button uses the shared custom tooltip and its cursor uses the outline X-on-line symbol.

Dragging excludes the moving point and its coincident partners from snap targets. While a drag update is pending, retain the newest pointer position and always apply the release position. A click without movement only selects.

Dragging a line moves both endpoints together according to their constraints. Endpoint targets use the line and pointer positions at drag start; the endpoints and their coincident partners are excluded from snapping. Projected lines remain read-only.

Dragging a fit-point or control-point spline curve moves all its defining points and tangent handles together. A free spline translates without changing shape; permanent constraints take priority and may limit or deform the movement. Compute absolute targets from the gesture's starting positions, exclude those points and their coincident partners from snapping, and retain the latest release target. Individual point/handle editing remains available; projected splines remain read-only.

Dragging a circle rim or arc edge first resizes it with its center held; arcs also prefer unchanged endpoint angles. Dragging an arc center prefers translation with unchanged radius and sweep. Permanent constraints take priority over these temporary preferences. Projected geometry remains read-only.

Drawing previews and dragging start immediately, with one update in flight and only the newest input waiting. Display completed previews during continued movement. Background updates keep the sketch ribbon usable; commits temporarily block it. Finish sketch stays disabled throughout unfinished drawing and dragging, including gaps between responses, until geometry is committed or cancelled and the last update settles. Finish does not add unfinished geometry. Completion uses the final input. Escape, tool changes, and document suspension invalidate pending previews.

Points are visible small circles; spline fit points use squares when their handles are independent. Constrained, partially constrained, unconstrained, explicitly fixed and projected geometry have distinct shared [palette colors](default_palette.md#viewport-and-user-colors). Selection overrides their color and doubles line width and point size. Construction geometry is presented as dotted lines. New geometry is visibly unconstrained before DOF results are available.

When a tool, constraint, or a geometry is selected, a part of tool window changes accordingly.

Every geometry displays live dimensions during creation - with an ability to navigate between editable dimensions via tab and entering a dimension value. Every dimension is a formula. 

Line clicks create a connected chain with coincident endpoints. Enter on the canvas ends the chain at the last committed endpoint and leaves Line active; Enter in a typed length field commits that segment and ends the chain. Escape discards the pending segment and exits Line. Deleting a line removes its endpoints and their constraints unless another curve uses those same endpoint entities.

Drawing starts with a canvas point. Editable dimensions appear beside the draft on the canvas; the tool window has no generic X/Y/width/height inputs or geometry submission buttons. The final click or Enter from the canvas or a geometry input completes geometry using the current dimensions. Enter finishes a spline using its confirmed points. Offset, Fillet and Scale show canvas formulas and draggable live previews; release or Enter commits and Escape discards the draft. Offset, Fillet, Scale and Move use thin open arrowheads with generous invisible hit areas; solid-workspace handles retain their existing style. Move retains its Apply button. Split highlights valid intersections; click to split all editable curves at that crossing only.

Live drawing dimensions are standalone inputs without visible captions, surrounding panels, or tooltips. Use 10px text and 20px height, with accessible names. Numeric values include the document's length or angle unit. Typed formulas remain visible while editing; on blur, show their evaluated value in document units and restore the source on focus.

Dimension labels and numeric edit fields show up to four decimal places, trimming trailing zeros. Compact fields and high-contrast numbers follow the shared palette. Formatting preserves formulas and the full stored precision when a value is accepted unchanged.

Selected geometry half-highlights every directly related constraint. Selecting a line also includes constraints on its endpoints; selecting a point does not inherit constraints on its owning curves. A selected constraint half-highlights its direct geometry. For Coincident and Point-on-curve, follow coincidence chains and include curves incident to those points and curves attached by Point-on-curve. Expansion stops at those curves. Half-selection is visual only: use a 50% blend of selection orange and the viewport background, 1.5 px lines and 10.5 px points. Explicit selection takes priority; commands and Delete use only explicitly selected items.

In-sketch constraints reuse the ribbon SVGs and palette. Place Equal, Parallel and Collinear beside both participating curves. Line buckets sit beside the midpoint, perpendicular to the line; Equal on circles/arcs uses the full circle's screen upper-right bounds regardless of arc sweep. Midpoint and line Horizontal/Vertical use the line bucket. Perpendicular uses a shared endpoint's point bucket when present, otherwise both line buckets. Point-on-curve, Coincident, Concentric and Tangent use the associated point, common center or tangency point. Symmetry and two-point Horizontal/Vertical use both points. Fix uses the corresponding geometry bucket (a spline's curve midpoint).

Point buckets sit screen upper-right and merge at coincident locations. Each bucket reserves a square grid with `ceil(sqrt(count))` columns and rows: 3 icons use 2×2, 5 use 3×3. Use 14 px icons, 3 px spacing and a 6 px offset from geometry. Keep ordering and local placement stable; nearby geometry and annotations must not displace buckets. Draw geometry and points above overlapping icons so intersections stay visible; retain overlap picking. Recalculate on geometry or view changes. Repeated markers retain one constraint identity for selection and deletion.

If sketch creates a closed region, then this region should be highlighted.

## Tool window

The Sketch workbench ribbon contains Geometry, Constraints, and Tools sections, each with two rows of icons. Tool variants and parameters remain in the tool window, including a single Geometry row with Normal and Construction icons. These set the selected geometry mode, or the drawing mode when nothing is selected. Creating or editing a sketch activates this workbench; Finish or Cancel returns to Solid. Switching document tabs restores each document's workbench and active tool.

A tool window appears in the sketch mode, some of the interface is shared and some is action-dependent. The interface is defined in sections:

- Geometry mode: normal / construction icons with explanatory tooltips
- Recompute automatically checkbox and a status panel (constrained / unconstrained / dof), for the selected object or the whole sketch. Show Recompute only when automatic recompute is off.
- Currently selected tool configurations, see below
- Highlight: caption and one row of icons for none / constrained / partially constrained / unconstrained
- Display: caption and one row of icon toggles for lines, points, constraints, dimensions, construction geometry, projections
- Snap: caption and one row of icons for geometry snapping and grid snapping
- Cancel sketch / Finish sketch

Separate geometry/status, active-tool configuration and display options with full-width rules and subtle backgrounds, without captions for the two shared groups. The active tool has a title and outline icon; Point shows “This tool has no configuration.” Line shows “Enter to finish, Esc to exit”. Multi-mode geometry tools show every supported variant with an icon, visible name and selected state; dark orange dots mark picked points and dashed lines mark guides. Highlight, Display and Snap use compact outline icons. In selection mode, hide the tool section and the rule between the shared groups. Keep the sketch actions outside the scrolling fields.

Highlight defaults to None. Choosing a category highlights matching geometry in the shared green color while other geometry keeps its normal colors. Constrained includes fixed geometry; orange selection takes priority. Clicking the active category again, or None, clears highlighting.

Sketches are auto-named and can be renamed later. The tool window has no name field, help paragraph, or References section; retain the plane-change implementation for future use.

## Tool configurations

Icon selectors

- Rectangle: 2 point rectangle; rectangle at angle (3 points); centered rectangle
- Circle: center point; two point and radius; three point; 2 tangent and radius; 3 tangent 
- Arc: center, point and angle; 3 point
- Ellipse: center, width and height; rectangle; center, side point and radius
- Slot: 3 point slot; center and line slot, center to center slot
- Spline: fit point; control point. Click the first point to close; Enter finishes an open curve.
- Text: compact multiline text area, grouped font-family dropdown, weight dropdown, Bold/Italic style icons, formula size with document units, and labeled horizontal/vertical alignment groups. Keep text Done/Cancel actions inside this section. Bold stays synchronized with weight; unavailable font styles are disabled. Guideline selection is omitted from this panel.
- Edit/Offset: icon variants for one side, symmetric and independent sides; one or two canvas distances and drag handles. Symmetric distance is per side. Offsets stay linked to their source curves and retain distance formulas. Double-click a generated curve or distance label to reopen the saved mode and distances. Drag saved labels or dimension lines to reposition them. During creation/editing, drag a dimension line or Alt-drag an arrow to reposition it without changing distance; ordinary arrow dragging changes distance. Each side retains its own placement. Source edits update the offset; deleting generated geometry removes its whole offset.
- Edit/Fillet: a canvas radius formula and drag handle for selected corners. Default radius is one tenth of the shortest selected line, rounded proportionally to `1, 2, 2.5, 5 × 10ⁿ` in document units, independent of zoom. With no line, use the shortest selected curve length (sampled for splines/ellipses). Typed and reopened radii are preserved. Created arcs retain tangent connections and an editable radius dimension; double-click the radius to edit or drag its handle again. Drag inward to increase the radius and outward to decrease it.
- Edit/Scale: a canvas scale formula and draggable arrow around a pivot selected with the crosshair icon; always modifies the selected geometry in place.
- Edit/Move: a pivot dot, detached X/Y arrows, a 90° arc with a circular rotation grip, and a square for free XY translation. The arc has a 64 px radius and the arrows reach 104 px from the pivot, independent of zoom. Only the active control shows its formula; XY shows both lengths. Click a handle to expose its field, or focus it and press Enter/Space. Enter hides the field (advancing X to Y for XY); a blank-canvas click also hides it. Rotation is unrestricted. Apply commits the combined transform; Copy and the pivot icon remain in the tool window. Pending or rejected moves retain the last accepted geometry, handle positions and displayed values; Escape cancels the draft.

### Panel checks

Verify titles and loaded icons for all nine geometry tools; Point empty state and Line completion hint; every drawing variant's icon and selection state, including all three rectangle types; Spline's endpoint closure; and Text's grouped font picker, permission/import controls and seven alignment options. Keep geometry creation, text placement/Done, document switching, panel resizing and collapse unchanged. At 280 px and wider, fields and icon rows fit without horizontal scrolling; section boundaries and titles follow the theme, with no separator between shared groups in selection mode. Text fields share the standard field border and the labeled alignment buttons have visible borders.

## Tool annotations

- Constraints
  - Symmetric: two points symmetric to a line
- Edit
  - Split: basically, insert point at crossing point and split curves or lines

# Implementation details

Only non-construction, closed geometry creates valid regions to use with commands.  

Dimensions should be accessible throughout the whole document. Dimensions could be referenced directly (sketch5 -> dimension31, note that dimensions may be removed without re-enumerating all following dimensions, so it's not just and indexed array), or by sketch and dimension names (something line scene.sketches.findByName and sketch.dimensions.findByName).

Fit curves expose tangent handles with ordinary, constrainable point tips. Handles start aligned on opposite sides of the fit point with independently adjustable lengths. Double-click the fit point to toggle between aligned and independent handles; releasing alignment preserves the shape, and aligning again keeps the lengths independently adjustable. Dragging a fit point carries its handles. Control curves show the construction polygon connecting consecutive control points. Both kinds of helpers remain construction geometry and belong to their curve.

Connecting spline endpoints while drawing, snapping, or applying Coincident shares one point while keeping the curves separately selectable. Clicking the starting point closes a draft, so there is no Closed checkbox. Existing constraints and dimensions follow the retained point; conflicting joins fail without publishing a partial change.

Complex geometries are collections of constrained simpler primitives. A rectangle consists of four ordinary lines, with their endpoints joined by pairwise coincidence constraints; each line remains independently selectable and editable. A slot consists of two arcs, two side lines, and a construction line between the arc centers. Centered rectangles also have two construction diagonals and a midpoint. Slots have a construction midpoint on their centerline. These helpers remain selectable and constrained to the boundary geometry.

Two-point circles use the final cursor position to vary radius and choose the center side; a typed radius overrides that value. Three-point circles expose an editable radius after the second point; typing it preserves the first two points and uses the pending cursor to choose the solution. Tangent circles accept preselection or curve picks after tool activation, then a placement click. Two-tangent radius entry stays on the canvas. Invalid radii or unsolvable tangencies keep the draft editable.

Ellipses have two perpendicular full-length construction axes whose endpoints follow the ellipse. Typed width and height create length dimensions on these axes. The center/side/radius mode uses the center, an axis endpoint to set orientation and half-width, then a perpendicular radius point to set half-height. Axis dimensions retain full width/height values.

Center-based arcs use three clicks: center, start point, and sweep endpoint. Three-point arcs use the two endpoints first, then a point on the arc. Both preview the final arc under the cursor; an angle becomes driving only when explicitly entered.

Three-point slots use the two outermost tips, then a radius point; center-to-center slots use the two cap centers, then a radius point. Radius is the perpendicular distance to the selected axis. For outer-tip slots, the diameter must be less than the overall length. Center-and-line slots use the midpoint, one cap center, then a radius point. Every new slot starts with a small viewport-relative preview radius, capped relative to its axis length, without inheriting another tool’s radius. Cursor movement sets perpendicular radius; an explicitly entered formula overrides it. Rectangle, arc, and slot variants use icon buttons with tooltips.

# Projections

Any solid geometry can be projected to a sketch; when using "project" the user can select points, edges or faces of any existing geometry. Similarly to the sketch plane, the geometry is cached. Lost geometry can be removed or updated in a workflow.

Projection is orthogonal along the sketch normal; selecting a face projects its boundary edges. Projected geometry is linked and read-only. If its source disappears, the cached geometry remains usable with a warning until the reference is repaired or removed.

Circular projections retain circles/arcs and selectable centers/endpoints, supporting Tangent and radius/diameter dimensions. Oblique noncircular projections retain exact rational splines. Old circular projections stored as splines must be removed and projected again; incompatible cached topology is not replaced automatically.

# Dimensions

The Dimension tool (D) infers radius from a circle/arc, length from a line, distance from two points or a point and line, perpendicular distance from parallel lines, and angle from nonparallel lines. A driving parallel-line distance also maintains parallelism; removing it removes that equation. Cursor placement chooses the angle sector. Right-click offers other applicable measurements (diameter, horizontal/vertical distance, ellipse radii, orientation/span).

Click to place the preview, enter a formula, and press Enter; Escape cancels. Creation and double-click editing replace the dimension label with a standalone input, sharing live drawing input styling and following camera changes, without a surrounding popup. Closing the field restores the label; invalid formulas remain editable. Dimensions show extension lines, arrows and values in the sketch. Drag their lines or labels to reposition annotations without changing geometry or DOF. Placement is stored in sketch coordinates and survives Finish/reopen; Cancel restores it. Double-click edits a driving formula; right-click handles naming and driving/driven mode.

Dimensions can be created during any drawing of a geometry, or later (by using dimension tool). Dimensions use the shared formula solver, that can compute lengths or reference other dimensions (like dimension133, by name, or from other sketch - sketch23dimension444, or sketches[main]dimension[width]). Dimensions can be removed at any time, double-clicking a dimension allows to change the value, and right-click allows to rename it via a popup menu.

Cross-sketch formula dependencies must be acyclic. Within a sketch, driving expressions that reference driven measurements are solved simultaneously with the geometric constraints. References bind to stable IDs, so renaming does not break existing formulas; deleting a referenced dimension reports a dependency error.

Dimension can be driving or driven; driving dimensions are used in computation, driven are not, and driven are created when adding a driving dimension would over-constrain the sketch. Right-clicking a dimension can switch it from diving to driven and vice versa if this does not overconstrain the sketch.

Dimensions can reference driven dimensions during computation, for example this approach should be possible: create a fixed length line, and add two points, lets name line ends A and B, and points C and D. Create a driven dimension between D and B; crate a driving dimension between A and C, that references the first one. Create a driving dimension between C and D, that references the second one. Now the C and D should be evently distributed and all three dimensions should be equal.

While editing a sketch formula, click any other driving or driven dimension to insert its stable reference at the caret, replacing selected text. The field retains focus; the click does not select geometry or move the annotation.

# Constrained and unconstrained sketches

Constrained and unconstrained sketches can be used in the same way be other tools and commands, as long as they create closed regions.

# Text objects

Straight text has a construction rectangle with diagonals and a center point. Its typographic bounds include advances, spaces, ascenders, descenders, line spacing and empty lines. Corners, edges and center can be used for snapping and constraints. Text controls its size; constraints control placement and rotation. Helpers cannot be independently edited or removed until conversion. Text edits retain helper references and reject conflicting constraints atomically.

Text remains an editable object: select it as a whole, double-click to edit its settings, and use the context menu to convert it to ordinary sketch geometry. Clicking to place new text anchors a draft and opens its settings; only Done commits it. Cancel or Escape discards the draft, and Finish sketch remains unavailable until it is completed or cancelled. After Done, the text tool remains ready for another placement. Conversion preserves exact lines and curves, boundaries and region references. Non-construction text supplies regions before conversion, including glyph holes and disconnected characters. Outline points and curves cannot be edited independently until conversion. Size retains its formula and computed value; multiline layout uses font metrics.

Roboto is the only bundled font. Group the font list into Document (Roboto and the active document's imported/embedded fonts) and System (installed fonts available with access). Keep sources distinct when family names match. Place an Import button beside the Font caption. In supported browsers, activating Text requests font access directly from the user interaction; avoid repeated automatic requests after dismissal or denial, and retain Allow now for explicit retry. Below the list, show “No permission to access local fonts. Allow now” when permission is absent, with Allow now requesting access. When the API is unavailable, show “Accessing system fonts is not supported in <browser name>, use Chrome or import a font”. Native builds list installed fonts directly. Use actual font faces/variation axes rather than simulated bold or italic; retain selected font bytes and collection index with editable text.
