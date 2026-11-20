# UI definition

## UI structure

UI should look the same on desktop and in browser. Mobile UI is not supported. During initial load the app should display a loading screen.

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

- Modelling
  - Solid
    - New sketch
    - Extrude

### Working area

3D viewport of the current scene with a scene browser on the left (tabbed, full height block displaying Construction / Bodies / Sketches ), and a 3d view on the right. On the 3D view there are at least three overlays - a gizmo cube, axes and a home button in the top right, a current tool configuration in the pop-up just below the gizmo, and a misc switcher in the right bottom corner.

See [Scene browser](scene_browser.md) for more details.
See [Working area and tool window guidelines](working_area_and_tool_windows.md)

### Timeline

Current timeline display.

### Logs and JS console area

Tabbed logs windows. **Console** is an interactive js console, and **CAD log** logs every  command sent to backend. **Scene browser** displays current scene as a browseable tree view.

This block is collapsed by default, and can be popped out (and back) as a separate window, similar to Chrome dev console. To open console, click "Debug console" button.

See [Logs and console](logs_and_console.md) for more details.

### Status line

Thin line, displaying either current status or a progress bar for lengthy operations (e.g. timeline recalculation).

See [Status line](status_line.md) for more details.