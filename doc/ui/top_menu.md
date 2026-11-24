# Top menu definition

- File
  - New Scene - opens new tab
  - Settings - see [Settings](top_menu/settings.md)
- Tools
  - Capture screenshot — PNG at the display's native pixel density, with menus closed; browser download on web, Save As on desktop.
    - Full app — document tab bar through status bar, including docked panels.
    - Viewport with UI — viewport including tool dialogs, handles and navigation controls.
    - Viewport without UI — same view and visible scene content (including grid, axes, construction planes and sketch annotations), without dialogs, handles or navigation controls.
- Help
  - Reset UI - reset all saved UI data, including toolbar states, positions, dialog customizations etc
  - About - small dialog window with app version, occt version and a link to github

## Screenshot checks

- Verify all three menu actions in web and native builds, including keyboard submenu navigation and About without navigation instructions.
- Decode saved PNGs at 1×, 2× and above 2× density; verify exact capture bounds, nonblank geometry, icons/text, tool dialogs and navigation controls in the appropriate modes.
- Capture during sketch editing and extrusion preview, retaining scrolled panels and checkbox state. Preserve camera, geometry, selection, input values and normal rendering after capture, cancellation or failure.
- Verify browser downloads, desktop PNG saving, Save As cancellation, and reported save errors. Floating output windows are outside the main-app capture.
