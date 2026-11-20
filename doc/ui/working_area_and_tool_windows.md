# Working area and tool windows

This documents describes general principles that should be used while implementing any new behaviour in working area, tool windows, popup-dialogs and navigation.

# The selection context

If there is no active tool and user selects something in the working area (click to select, shift+click to add or remove from the current selection), the editor should keep this selection and present it to a tool should it activate. The tool then decides whether to use or discard the selection. For example, if a user selects a face and starts a fillet operation, the face becomes an input for a fillet, but if a current selection is an edge and user starts an extrude operation, the selection is discarded by the tool.

If a tool is active it should provide a filter of valid selection targets - bodies, faces, edges, meshes, mesh triangles etc. The filter may change dynamically - for example if a tool requires a plane and a mesh as inputs, the working area should react accordingly, dropping existing selection if needed.

# Drag and numeric inputs

Any numeric input, like angle and length, should be represented both as a numeric input and a draggable control in the working area (for example, a length is represented by a draggable arrow, and an angle with a rotational handle). Dragging the controls updates the preview, and dragging happens in discreet steps that are unit dependent:

- angle: fixed 5 degree increments, or P/36 radians
- length: increments change based on screen scale and unit. Increment is picked in a way that dragging half a screen takes around 25 steps, but the real steps is selected based on the unit in a way so the number is "round" - so 10, 2.5, 100, 1000, 50 and other 25 increments for millimeters and lengths above 10 inches, and 1/8, 1/16 etc for lengths less 10 inches.

Any dragging updates text input in a tool configuration window. Any text input changes value in a configuration window:

- if a value has been changed through interactive controls then the value is written to a text input with units (if the input is a formula) and the whole text is selected and keypress overrides the value
- if a value has been changed through user input, standard cursor-based editing rules apply

# Tool configuration windows

Every tool configuration window should present all possible inputs and settings from the protocol definition. There may be additional styling and icons per user definition.