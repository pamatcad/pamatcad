# UI definition

## UI structure

UI should look the same on desktop and in browser. Mobile UI is not supported. During initial load the app should display a loading screen.

See [Default palette and visual style](default_palette.md) for colors, typography, icons and control sizes.

## Tooltips

All controls in the Solid and Sketch ribbons and the Sketch and Extrude tool windows use shared custom tooltips, including disabled buttons, fields, selectors, and window movement, resize and collapse controls. Command controls use the documented Name; without command information, retain their existing tooltip or concise label, such as “New sketch”. Canvas dimension inputs remain tooltip-free.

Use the theme's graphite foreground as the tooltip background and its white background as text color: 12 px text, 18 px line height, 5 px vertical and 8 px horizontal padding, and 4 px corners, without animation. Show the name after 100 ms of hover; switching controls within 500 ms of a visible tooltip is immediate. Keyboard focus shows the name immediately.

At 500 ms total hover or focus time on the same control, retain the name and add its Short Description and optional `illustration.svg`. Restart this timer for each new control; controls without additional information remain compact. Expanded tooltips are at most 320 px wide, with the illustration on a white inset at its original aspect ratio. Place tooltips 6 px below the control (below both rows in ribbons), flip above when necessary, and keep 8 px from window edges, including after expansion.

The editor build reuses the [command documentation sources](../generation.md#additional-documentation) through the shared spec parser. `data-tooltip-command` identifies the documented command (for example `solid.extrude`); `data-tooltip` supplies the fallback label. Missing illustrations are omitted.

Keep the tooltip visible while its control has keyboard focus or the pointer is over the control or tooltip; allow 100 ms to cross the gap. Dismiss on keypress (including Escape), pointer press, scrolling, window resize or blur, or removal/hiding of the control. Preserve existing shortcuts and field error descriptions. Use `role="tooltip"` and `aria-describedby`, with no duplicate native tooltip.

Verify all four areas, disabled controls, 100/500 ms stages and immediate label switching, fallback labels and missing illustrations, cancellation before expansion, keyboard focus and Escape, expanded content near window edges, formula error descriptions, dynamically replaced variants, document switching, window collapse and resizing, and exclusion of canvas dimension inputs.

## Screen structure

### Header 

#### Top menu

File and Help. On OSX systems this should be the system top menu.

See [Top menu](top_menu.md) for full menu structure.

#### Tab bar

List open scenes. Each "new scene" opens a tab. There is a home button in front of all tabs, which currently alerts "Not implemented".

#### Ribbon area

There are multiple ribbon configurations that can we switched with a selector on the left or the ribbon. Each ribbon is divided by sections, each sections has two rows of icons.

Currently the sections, starting from ribbon configurations, are:

- Solid
  - Solid
    - New sketch
    - Extrude
- Sketch - see [Sketches and sketch workbench](sketches.md)
  - Geometry
    - Point
    - Line
    - Rectangle
    - Circle
    - Arc
    - Ellipse
    - Slot
    - Spline
    - Text
  - Constraints
    - Equal
    - Coincident
    - Fix
    - Concentric
    - Midpoint
    - Parallel
    - Perpendicular
    - Tangent
    - Horizontal
    - Vertical
    - Symmetric
    - Collinear
    - Point on curve
  - Tools
    - Dimension
    - Offset
    - Split
    - Rounding
    - Scale
    - Move
    - Project

### Working area

3D viewport of the current scene with a scene browser on the left (tabbed, full height block displaying Construction / Bodies / Sketches ), and a 3d view on the right. On the 3D view there are at least three overlays - a gizmo cube, axes and a home button in the top right, a current tool configuration in the pop-up just below the gizmo, and a misc switcher in the right bottom corner.

See [Scene browser](scene_browser.md) for more details.
See [Working area and tool window guidelines](working_area_and_tool_windows.md)
See [Interactive Extrude](extrude.md) for tool behavior and acceptance cases.

### Timeline

Current timeline display.

### Logs and JS console area

Tabbed logs windows. **Console** is an interactive js console, and **CAD log** logs every  command sent to backend. **Scene browser** displays current scene as a browseable tree view.

This block is collapsed by default, and can be popped out (and back) as a separate window, similar to Chrome dev console. To open console, click "Debug console" button.

See [Logs and console](logs_and_console.md) for more details.

### Status line

Thin line, displaying either current status or a progress bar for lengthy operations (e.g. timeline recalculation).

See [Status line](status_line.md) for more details.
