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

Use `remove(ids)`, `construction(refs, enabled)`, `drag(point, position)`, and `transform({ entities, pivot, translation, angle, scale, copy })`. `modifyCurves(curves, operation)` supports `split`, `offset`, and `rounding`; its result identifies removed geometry, constraints, and dimensions. An offset's second distance applies to the opposite side.

```js
const projection = await sketch.projections.add({ type: "face", reference: face });
await sketch.projections.update(projection.id, { type: "face", reference: replacementFace });
await sketch.remove([projection.id]);
```

Project faces, edges, or vertices. `body.vertices.all()` returns exact vertex references and coordinates without tessellation; body proxies also include them. Projections are read-only and retain cached geometry if their source is lost. Repair them with `projections.update`, or change the support with `support.update(planeOrFace)`. Read the current support from `state().sketch.plane`.

See [Sketch editing](../../../doc/api/command/sketch/edit/spec.md) for the operation contract and tests.
