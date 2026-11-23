# Naming and sizes

- **icon.svg** - 32x32 icon for the editor toolbar and captions, 16x16 icon inline. The icon itself is colored and filled. Action and geometry should retain the meaning in both sizes.
- **illustration.svg** - 512x256 illustration to use in documentation or editor popups, explaining the operation, inputs and results.

By default, the icons represent the light theme. Use a transparent canvas and a matching SVG `viewBox`. Give each asset a short `<title>` and the illustration a `<desc>` explaining the diagram.

Follow [Palette](palette.md) for color scheme. Toolbar and variant SVGs use semantic classes for fills, edges, construction, handles and illustrated points, with standalone fallback colors. Illustrated points use contrasting copper. Inline asset imports let the editor map these classes to the shared theme; keep the editable geometry in the SVG files.

##