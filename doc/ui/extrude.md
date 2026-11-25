# Scope

Editor selection, formula controls, tool windows, and interactive solid extrusion. General rules are in [Working area and tool windows](working_area_and_tool_windows.md); modeling rules are in the [Extrude specification](../api/command/solid/extrude/spec.md).

# Intent

Configure and preview every supported extrusion input using the tool window and working area.

# Inputs

Click replaces selection; Shift-click toggles an item. Each document owns its selection. Starting Extrude consumes compatible sketch regions or coplanar planar faces and discards incompatible items. Extrude can also start with no selection. Its active geometry field filters picking to profiles, starting faces, limiting bodies, or target bodies. Geometry fields retain their own inputs when switching between them.

# Parameters

Expose the protocol's start, sides, direction, extents, symmetric length, tapers, result mode, and targets. Only applicable parameters are submitted. All bodies is the default Boolean target scope; Selected bodies requires at least one body.

Length and angle fields use the scene formula evaluator and retain typed expressions. A handle writes an explicit scene-unit value and selects the text. Typing preserves normal cursor editing. Angular dragging snaps to 5° (π/36 rad). Length steps use the nearest `1, 2, 2.5, 5 × 10ⁿ` increment to approximately 25 steps per half-screen; below 10 inches they use powers of two, down to 1/1024 inch. Snap scale is fixed for a drag.

The tool window moves by its title bar, stays within the viewport, and scrolls its fields when necessary. Its position and draft survive document switching.

Use a 320 px window with an Extrude icon in the header, Profiles/Extent/Result sections, compact pick-and-clear rows, and One side/Two sides/Symmetric buttons. Show selected geometry in sage, with full selection details in the shared custom tooltip. Label symmetric length as Total length or Half-length. Formula fields use the shared UI font and tabular numerals. Keep Cancel, Apply and operation errors in the footer; every interactive control retains its custom tooltip.

# Preview, results and effects

Viewport changes share one render per animation frame. Handles retain their geometry and materials while updating position, orientation, scale, and color; remove their resources when the handle disappears or changes kind. Adjacent surface ranges with the same material share a draw group without reordering triangles or changing face references.

The source sketch is hidden after the extrude operation is complete. No bodies are selected after the extrude operation.

# Topology and references

Use model region and face references for extrusion. Sketch proxies supply world-space region boundaries and the sketch frame; planar face properties supply the exact frame. Display samples do not become modeling inputs. Selection drops topology belonging to obsolete body revisions.

# Errors

Display field formula errors and operation errors in the window. Reject incompatible profile types, regions from different sketches, nonplanar profile faces, and noncoplanar faces. Invalid inputs never commit geometry.

# Test cases

- Start without selection, select a region, change formulas and apply; compare body volume with the requested dimensions. Reject an invalid or dimensionally incorrect expression, then recover.
- Select multiple regions with Shift-click, remove one, and extrude the remainder. Select a planar face before opening Extrude; retain it and join outward. Discard preselected edges. Reject cylindrical profile faces.
- Switch geometry fields and verify the picking filter and retained inputs. Exercise offset and face starts, both directions, unequal sides, symmetric total/half length, both tapers, all end conditions and stopping positions, and all result/target modes. Compare preview and committed body effects and shape properties with the API scenarios.
- Drag length, offset, and taper controls in orthographic and perspective views. Verify unit text, select-all replacement, normal typed cursor editing, 5° angular steps, metric/imperial length steps at different scales, camera stability during dragging, and recovery from invalid geometry.
- Move the tool window, resize the viewport, and switch documents with pending draft edits. Restore each document's fields, selection inputs, position and preview. Cancel and repeat an extrusion without stale overlays or altered committed geometry.
- Hold preview and proxy responses while changing a handle repeatedly. Display the completed intermediate result, submit only the newest pending value after all mesh requests settle (including failures), and keep Apply disabled until that value is validated. Typed edits and cancellation reject obsolete results; invalid formulas recover. Scheduling introduces no timeout delay.
- Multiple viewport updates before a frame produce one scene render; an idle viewport does not redraw. Repeated handle updates preserve geometry/material identities, maintain screen size and orientation, and release only removed handles. Surface groups merge for unselected, whole-body, adjacent-face, and separated-face selections while canvas picks retain the same face references.
- Query multi-region rectangle/circle sketch proxies on XY, XZ, YZ and a planar face. Verify references, boundary points and orthonormal frames; repeated queries leave geometry and timeline unchanged. Incomplete sketches reject proxy requests. Curved face properties omit a planar frame.
- Verify the refreshed sections, side buttons, geometry summaries and clear actions, shared formula font, custom tooltips (including disabled controls and field errors), and live palette changes. At the 280 px minimum width and short viewport heights, keep controls readable and the footer visible. Reset restores the 320 px Extrude default while Sketch retains 280 px.

# History

Initial interactive Extrude implementation.
Response-driven preview scheduling, frame-coalesced drawing, persistent handles, and merged surface groups.

2026-11-25: Refreshed the Extrude window layout and controls. Extrusion interactions, tooltips, window lifecycle, preview scheduling, live theme checks and web/desktop UI builds pass.
