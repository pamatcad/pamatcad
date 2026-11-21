# Working area and tool windows

This documents describes general principles that should be used while implementing any new behaviour in working area, tool windows, popup-dialogs and navigation.

# The selection context

If there is no active tool and user selects something in the working area (click to select, shift+click to add or remove from the current selection), the editor should keep this selection and present it to a tool should it activate. The tool then decides whether to use or discard the selection. For example, if a user selects a face and starts a fillet operation, the face becomes an input for a fillet, but if a current selection is an edge and user starts an extrude operation, the selection is discarded by the tool.

If a tool is active it should provide a filter of valid selection targets - bodies, faces, edges, meshes, mesh triangles etc. The filter may change dynamically - for example if a tool requires a plane and a mesh as inputs, the working area should react accordingly, dropping existing selection if needed.

# Drag and numeric inputs

Any numeric input, like angle and length, should be represented both as a numeric input and a draggable control in the working area (for example, a length is represented by a draggable arrow, and an angle with a rotational handle). Dragging the controls updates the preview, and dragging happens in discreet steps that are unit dependent:

- angle: fixed 5 degree increments, or P/36 radians
- length: increments change based on screen scale and unit. Increment is picked in a way that dragging half a screen takes around 25 steps, but the real steps is selected based on the unit in a way so the number is "round" - so 10, 2.5, 100, 1000, 50 and other 25 increments for millimeters and lengths above 10 inches, and 1/8, 1/16 etc for lengths less 10 inches.

Angle is a semi-translucent circle with a handle. A part of a circle representing the angle is non-transparent, indicating the current extent. There is also a small text in the center of the circle displaying the current angle, with units.

Length is a flat wide arrow. A dotted line with a current length, with units, connect the origin of the operation to the base of the arrow.  

The tool code should define attachment points for the controls; for example an Extrude operation defines the length arrows as starting from the center of a geometry being extruded, and a taper angle circle is located near the model.

Any dragging updates text input in a tool configuration window. Any text input changes value in a configuration window:

- if a value has been changed through interactive controls then the value is written to a text input with units (if the input is a formula) and the whole text is selected and keypress overrides the value
- if a value has been changed through user input, standard cursor-based editing rules apply

Preview updates are made in a best-effort manner - the first preview starts immediately with move and the second preview does not start unless the first is finished. 

Formula and selection edits invalidate Apply immediately. Preview evaluation starts immediately when idle. While evaluation or mesh retrieval is pending, retain only the newest input and start it as soon as that sequence finishes, without a timer delay. During continued handle changes, completed intermediate previews may update the view; typed edits, geometry or option changes, suspension, and cancellation invalidate pending display results. Only the latest validated input enables Apply. Apply sends the validated request and preserves camera position, target, projection and zoom. Finishing or cancelling a sketch also preserves the current view. Cancel discards the overlay. Handles remain usable after a modeling validation error so the value can be corrected.

# Tool configuration windows

Every tool configuration window should present all possible inputs and settings from the protocol definition. There may be additional styling and icons per user definition.