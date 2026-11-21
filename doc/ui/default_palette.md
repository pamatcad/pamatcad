# Default palette and visual style

PamatCAD uses a compact, professional CAD interface with white surfaces, graphite details and restrained pastel colors. Steel represents geometry, sage selection, copper manipulation and blue UI actions. Sizes are logical CSS pixels at 100% UI scale.

## Surfaces

Keep the viewport, toolbars, sidebars, dialogs and input backgrounds white. Separate areas with spacing and thin borders.

| Element | Color |
| --- | --- |
| Main backgrounds | `#FFFFFF` |
| Primary text and ordinary icons | `#39434B` |
| Secondary text | `#65727B` |
| Panel separators | `#D9DEE2` |
| Input boundaries | `#87939C` |
| Neutral hover background | `#F2F5F7` |

## Semantic colors

Use pastel fills with darker companions for outlines, symbols and labels. Keep roles consistent across the viewport, scene tree, operation panels, icons and documentation illustrations.

| Role | Fill | Detail | Usage |
| --- | --- | --- | --- |
| Default geometry | `#CED3D5` | `#65727B` | Ordinary solid faces and edges |
| Active geometry | `#AEBEC3` | `#536974` | Geometry currently being edited |
| Sketch profiles | `#C5DDF0` | `#6588A3` | Flat sketch regions and live drawing previews |
| Selection | `#C0D8CC` | `#487561` | Picked faces, edges, bodies and points |
| Arrows and handles | `#DCB58C` | `#815A36` | Direction arrows and draggable controls |
| Primary buttons | `#C5DDF0` | `#294F6D` | Apply, Create, Save and similar actions |
| Construction | `#EDF1F3` | `#81909B` | Planes, boundaries, guides and points |
| Error | `#F5E4E6` | `#964650` | Error messages and symbols |
| Success | `#E7EFE8` | `#496D55` | Success messages and symbols |

- Geometry uses neutral lighting and restrained shading that preserves edges, holes and changes in surface direction.
- Active geometry identifies the editing context; a face on it can independently be selected.
- Sketch profiles use a translucent pale blue fill and blue boundary. Selected profiles and live drawing previews use a stronger fill and boundary `#294F6D`; solid selection remains sage.
- Selection combines a sage face tint with a stronger boundary. Selected tree rows use `#E7F0EB` with text `#315C48`.
- Hover uses a thin outline or subtle background change; persistent selection has a stronger treatment.
- Manipulation uses copper. Direction controls may repeat it in arrow symbols and selected backgrounds.
- Construction planes have faint fills, dashed boundaries and outlined points. Keep essential boundaries and points visible even when fills are translucent.
- Viewport axes use subdued red X (`#A4555D`), green Y (`#557B62`) and blue Z (`#6588A3`) with letter labels. The Construction icon is three plain axis lines, without a plane, arrows or letters.
- Errors and success pair color with symbols and text. Faulty geometry can use an error outline or hatch; success belongs in status feedback.

## Buttons and interactive states

Blue identifies primary actions, active tools, tabs and keyboard focus. Geometry selection remains sage.

| State | Treatment |
| --- | --- |
| Primary button | Fill `#C5DDF0`, text `#294F6D`, border `#6588A3` |
| Hover | Fill `#B6D3E9` |
| Pressed | Fill `#A4C7E1` |
| Active toolbar tool | Fill `#E7F1F8`, dark blue label |
| Secondary button | White fill, graphite text, gray border |
| Keyboard focus | 2px blue outline, 2px offset |
| Disabled | Dim content; no hover or pressed response |

Use one visually primary action per operation panel. Keep text dark on pastel fills.
The current toolbar tool keeps its blue active treatment while its activation button is disabled to prevent restarting it.
Inactive toolbar tools remain transparent and borderless, including when hovered or disabled. Only the active tool has a persistent background and border; keyboard focus remains visible.

## Typography

Use Inter with system UI fallbacks, sentence case, regular content, medium control labels and semibold headings.

| Usage | Size / line height | Weight |
| --- | --- | --- |
| Menus, tree items, field labels and input values | 13px / 20px | 400 |
| Buttons and toolbar labels | 13px / 20px | 500 |
| Panel and section titles | 14px / 20px | 600 |
| Dialog titles | 16px / 24px | 600 |
| Help text, units and status bar | 12px / 18px | 400 |
| Viewport dimensions and handle labels | 12px / 16px | 500 |
| Console and code | 12px / 18px | 400, monospace |

Keep essential text at least 12px. Use tabular numerals for dimensions, coordinates, timings and aligned numeric fields. Reserve monospace for code, formulas and technical output.

## Icons

Keep editable SVG assets in the existing icon directories. Use consistent proportions, viewing angles and lighting directions for geometry icons. New Sketch is a flat blue square and a pencil. Extrude uses steel sides, a sage top with a sage boundary, and a copper arrow with a darker outline.

| Location | Visible icon | Typical control |
| --- | --- | --- |
| Scene tree, menus and status bar | 16 × 16px | 24–28px |
| Compact toolbar and viewport controls | 20 × 20px | 28–32px |
| Main modeling tools | 24 × 24px | 32–36px |
| Disclosure arrows and small indicators | 12–14px | At least 24 × 24px when clickable |

Use approximately 1.5px strokes for small icons and 1.75–2px for larger modeling icons; check at actual display size. Ordinary icons use graphite. Modeling icons reuse steel solids, sage selected regions and copper arrows. Label major tools and provide tooltips for compact icon-only controls.

## Spacing and shape

Use a 4px spacing scale: 4, 8, 12, 16 and 24px.

- Standard buttons and inputs: 32px high; tree and menu rows: 28px high.
- Panel padding: 12–16px; related controls: 8px apart; sections: 16–24px apart.
- Icon-to-label spacing: 6–8px.
- Borders: 1px; control radius: 3px; floating panels and dialogs: 4px.
- Align panels and controls. Use subtle shadows only for floating menus, dialogs and detached panels. Scale text and controls with UI scale.

## Viewport and user colors

Keep the viewport white. Prioritize the model, then interaction feedback, then construction information. Starting screen-space edge widths are 1px for ordinary edges, 1.5px for silhouettes and 2px for selection. Keep their apparent width stable during zoom.

Default user colors are steel `#BAC5CD`, sage `#BDD1C3`, sand `#DEC8A5`, blue `#B5D0E6`, rose `#D8B9BB` and copper `#D7B391`. Allow arbitrary user colors. Preserve them during interaction; use temporary overlays, boundaries and contrasting halos for selection.

These guidelines define appearance for supported states; they do not introduce new editing modes or a color-assignment workflow.

## Verification

- Check the default palette, startup screen, menus, tool panels, status bar and detached console on white backgrounds.
- Confirm sage selection, steel previews and copper handles remain distinct from blue actions, including after a live theme round trip.
- Confirm sketch profiles have blue fills and boundaries, retain selection after theme changes, and inactive toolbar tools have no background or border.
- Inspect New Sketch and Construction at their actual toolbar and tree sizes.
- Verify text and controls fit at supported desktop sizes, with no clipped fields or overlapping controls.
- Preserve sketching, extrusion, selection, camera controls, document tabs, panel dragging and console docking.
- Target [4.5:1 text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [3:1 for essential control and state indicators](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). Verify actual rendering, including transparency and shading.
