# Planar sketches

Create a sketch on a scene plane or planar face. Geometry coordinates use its local 2D frame; numeric distances are millimetres and numeric angles are degrees. A rectangle creates four independent lines, endpoint pairs, and geometric constraints.

```js
const sketch = await scene.sketches.create(
  scene.construction.builtin.planes.xy,
  { name: "base" },
);
const rectangle = await sketch.primitives.add("rectangle", {
  from: [0, 0], to: [40, 20],
});
await sketch.constraints.add("coincident", {
  points: [sketch.origin, rectangle.points[0]],
});
const width = await sketch.dimensions.add("length", {
  line: rectangle.curves[0], name: "width", mode: "driving", value: "40 mm",
});
await sketch.dimensions.add("length", {
  line: rectangle.curves[1], mode: "driving", value: "width / 2",
});
await sketch.complete();
const feature = await core.solid.extrude(await sketch.regions.only(), { length1: 5 });
```

`primitives.add` also accepts `point`, `line`, `circle`, `arc`, `ellipse`, `slot`, `spline`, and `text`. Its generated parameter types define each constructor. Set `construction: true` to exclude geometry from region boundaries. Open and underconstrained sketches can be finished; only closed, non-construction boundaries yield extrusion profiles.

## Editing and evaluation

```js
await sketch.edit();
await sketch.dimensions.update(width.id, { value: "60 mm" });
const state = await sketch.state();
const display = await sketch.getProxy();
await sketch.complete(); // recomputes downstream features
// Or await sketch.cancel() to restore the previous completed sketch.
```

`state()` includes entities, constraints, dimensions, computed values, warnings, and whole-sketch/per-entity degrees of freedom. `settings({ autoRecompute: false })` defers solving until `recompute()` or `complete()`. Failed mutations preserve the previous working state. Finish updates the existing sketch timeline entry; Cancel removes an unfinished new sketch.

Names resolve through `scene.sketches.findByName` and `sketch.dimensions.findByName`. IDs remain stable after deletion and renaming. A formula can use a local dimension ID/name or `sketches[base]dimension[width]`. Within a sketch, driven measurements participate in simultaneous equations. Cross-sketch dependencies must be acyclic; referenced dimensions cannot be deleted.

## Display and previews

```js
await sketch.primitives.add("circle", {
  center: [20, 20], diameter: 10,
}, { preview: true });
const preview = await sketch.getProxy({ preview: true });
await scene.discardPreview();
```

Preview replaces the session’s temporary sketch, leaving the working sketch unchanged. `transform` and `modifyCurves` also accept `preview: true`. Proxy requests return sampled curves/points with entity mappings and region loops with holes. Rendering is explicit; it never creates timeline entries. See [Proxy behavior](../../../doc/ui/proxies.md).

## Editing tools and projections

Use `remove(ids)`, `construction(refs, enabled)`, `drag(point, position)`, and `transform({ entities, pivot, translation, angle, scale, copy })`. `modifyCurves(curves, operation)` supports `split`, `offset`, `fillet`, and legacy `rounding`; its result identifies removed geometry, constraints, and dimensions. Offsets remain linked and expose their definitions through `state().offsets`. `mode` is `oneSided`, `symmetric` (distance per side), or `independent` (requires `distance2` on the opposite side); omitting it infers one side or independent sides from the supplied distances. Edit with the original source references and `{ type: "offset", id: offset.id, mode: offset.mode, distance1: "3 mm" }`. Formulas retain dimension bindings; source edits regenerate geometry. Compatible topology retains generated IDs. Delete an offset by its ID or any generated entity; remove dependent offsets before their sources.

Reposition an offset label with `modifyCurves([], { type: "offsetAnnotation", id: offset.id, side: 0, position: [x, y] })`. Positions are sketch millimetres; side 1 requires Independent mode. This metadata-only edit leaves geometry, formulas and revision unchanged. An `offset` operation can also supply `annotations: [{ position: [x, y] }, null]` to commit draft placements; omitting the tuple preserves existing placements.

`{ type: "split", position: [x, y], tolerance: 0.01 }` cuts only at the nearest crossing within the supplied tolerance (millimetres; default 1e-7). Omit position for all intersections. `{ type: "fillet", radius: "2 mm" }` creates tangent arcs with driving radius dimensions. Edit those dimensions normally, or use `{ type: "fillet", radius: "3 mm", dimension: radiusDimension.id }` with the corresponding arc reference and optional preview. Existing constraints remain authoritative. The editor's Scale tool always transforms in place; the general API still supports copying.

`drag(line, { from: [x1, y1], to: [x2, y2] })` supplies absolute targets for both line endpoints in one solve. Endpoint order follows `state().entities[].geometry.from/to`. Permanent constraints take priority; targets do not add constraints or change DOF. During a gesture, derive targets from the starting endpoints and the total pointer displacement. With manual recompute, both endpoint coordinates are updated without solving.

`drag(spline, { points: [{ point: pointRef, position: [x, y] }, ...] })` moves a whole fit/control spline through one constrained solve. Supply every distinct `geometry.points` reference plus the spline's incoming/outgoing tangent tips exactly once; order is irrelevant. Capture their positions at gesture start and add total pointer displacement to obtain repeatable absolute targets. A free spline keeps its shape; permanent constraints may limit or deform the movement. Invalid/incomplete targets and projected splines are rejected atomically. Manual recompute updates all targets without solving.

`drag(curve, { position: [x, y] })` accepts a circle or arc and targets a point on its circumference. It prefers resizing with the center and arc endpoint angles held, then moves them if needed and permitted by constraints. Drag an arc's center point to translate it while preferring unchanged radius and sweep. Manual rim dragging updates the radius and arc endpoints around the existing center.

Dimensions accept `annotation: { position: [x, y] }` in sketch coordinates. Updating only this field does not solve or invalidate geometry/proxies:

```js
await sketch.dimensions.update(width.id, { annotation: { position: [20, -5] } });
const clearance = await sketch.dimensions.add("distance", {
  line: rectangle.curves[0], points: [point], mode: "driving", value: "5 mm",
});
```

For two parallel lines, use `curves: [line1, line2]` with `distance`; driving mode also maintains parallelism. Nonparallel lines require `angle`. Its optional `angleBranch` selects `direct`, `reversed`, `supplementary`, or `reversedSupplementary`; see the [command contract](../../../doc/api/command/sketch/edit/spec.md).

```js
const projection = await sketch.projections.add({ type: "face", reference: face });
await sketch.projections.update(projection.id, { type: "face", reference: replacementFace });
await sketch.remove([projection.id]);
```

Project faces, edges, or vertices. `body.vertices.all()` returns exact vertex references and coordinates without tessellation; body proxies also include them. Projections are read-only and retain cached geometry if their source is lost. Repair them with `projections.update`, or change the support with `support.update(planeOrFace)`. Read the current support from `state().sketch.plane`.

See [Sketch editing](../../../doc/api/command/sketch/edit/spec.md) for the operation contract and tests.

## Editable text

```js
const text = await sketch.primitives.add("text", {
  text: "First line\nSecond line", origin: [0, 0], size: "10 mm",
  horizontal: "center", vertical: "top",
});
await sketch.texts.update(text.id, { text: "Revised text" }, { preview: true });
await scene.discardPreview();
await sketch.texts.update(text.id, { size: "20 mm / 2" });
const { frame } = await sketch.texts.get(text.id);
await sketch.constraints.add("coincident", { points: [frame.center, sketch.origin] });
await sketch.texts.update(text.id, { text: "A longer label" }); // remains centered
const outlines = await sketch.texts.explode(text.id);
```

`texts.get(id)`, `texts.all()` and `state().texts` expose retained text parameters and owned outlines. Closed glyph outlines supply regions before conversion. Conversion keeps exact geometry and region references while releasing ordinary editable curves. Remove a text object with `remove([text.id])`.

Straight text also exposes a typographic construction `frame`. Its named corner, edge, diagonal and center references survive text changes. Constrain these to align the text; font layout controls width/height, and the solver controls placement/rotation. The frame contributes no regions. Drag its center to move the text; independent helper edits require conversion, which retains helpers and external constraints. Guideline text has `frame: null`.

Roboto is bundled. Supply `fontBase64` and an optional `fontIndex` for another font or collection; `fontFamily` is a display label. Weight and italic use actual font faces or supported variation axes. Font discovery belongs to the editor runtime; the core receives font data. Text updates atomically merge supplied fields, retaining omitted values; null clears optional font/guide fields. They retain the size expression and computed value, and the same object ID. See the [text contract](../../../doc/api/command/sketch/edit/spec.md#topology-and-references) for outline identity rules.
