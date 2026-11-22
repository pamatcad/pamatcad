# Body proxies

A body proxy is a display representation of one evaluated B-rep. The client explicitly requests it for rendering or picking. Modeling, preview evaluation, and timeline replay can run headlessly without tessellating bodies. Proxies and preview overlays exist only at runtime. Save files and timeline entries contain model data.

## Requesting a proxy

```ts
const feature = await core.solid.extrude(profile, { length1: 15 });
const body = feature.newSolids[0];
const committed = await scene.getProxyFor(body);

const preview = await core.solid.extrude(profile, { length1: 20 }, { preview: true });
const proposed = await scene.getProxyFor(preview.newSolids[0], {
  preview: true,
  revision: preview.revision,
});
await scene.discardPreview();
```

A plain lookup reads the committed shape. With `preview: true`, lookup reads only the editing session’s cached changed or created B-reps. An unchanged body, a removed body, or an expired preview returns `PREVIEW_UNAVAILABLE`. The optional `revision` guard returns `INVALID_STATE` when a different geometry revision is available. A missing committed body returns `NOT_FOUND`.

## Display data

Coordinates are in world-space millimetres. Ranges count vertices, triangles, or points from zero.

- `body` identifies the body. `revision` identifies the evaluated geometry. Treat revisions as opaque and compare them for equality.
- `positions` and `normals` are flat XYZ triples. `triangles` contains three vertex indices per triangle. The JavaScript SDK exposes these as `Float32Array`, `Float32Array`, and `Uint32Array` respectively.
- Each entry of `faces` maps a contiguous range `[firstTriangle, firstTriangle + triangleCount)` to a B-rep `FaceRef`. All triangles on a cylindrical wall select that same trimmed face.
- `edgePoints` is a separate `Float32Array` of XYZ samples. Each entry of `edges` maps `firstPoint` and `pointCount` to one solid `EdgeRef`. Join consecutive points and close the last segment when `closed` is true. Shared edges occur once. Degenerate edges with no drawable length are omitted.
- `vertices` contains exact B-rep vertex references and world coordinates; the same list is available without a proxy through `body.vertices.all()`.
- A pick belongs to the proxy’s revision. An edge reference includes that revision. Use model topology references for feature inputs. The model assigns selectable face IDs before publishing a body, so asking for a proxy cannot change subsequent face naming. Triangle indices, sample indices, and revision-local edge numbers are display data.

## Updating the view

**Drag.** One session has one active preview per scene. An update replaces the previous overlay. `newSolids` contains temporary body references and `affectedSolids` contains the existing references whose bodies change. The existing preview volume measurements are available in `newSolidProperties`, in the same order as `newSolids`. Request proxies for the created and affected bodies. Hide `removedSolids` by ID and retain the committed display underneath. Apply a preview update only while its revision still matches the current interaction.

**Cancel or commit.** Cancel calls `scene.discardPreview()` and restores the committed display. A successful model edit invalidates overlays for that scene, including those of other sessions. Disconnecting releases the session’s overlays. Preview-created IDs expire with the overlay. Use the commit result’s body references afterwards.

**Replay or load.** Finish evaluating the model, then call `scene.bodies.revisions()` once for the final view. It lists each present body and its revision without building any proxies. Reuse matching cached proxies, fetch new or changed bodies, and drop IDs absent from the list.

## Sketches and planar frames

`sketch.getProxy({ sketch })` returns the current sketch frame and each region's outer boundary and holes in world-space millimetres (the first point is not repeated). Display curves are sampled; region references remain exact modeling inputs. The SDK exposes this as `sketch.getProxy()` or `scene.sketches.getProxy(id)`. Working sketches can be queried during editing. `curves` maps sampled world points to sketch entities; `points` maps individual points to their entities. Both indicate construction/projected geometry. `sketch.state()` supplies constraints, dimensions and solve status separately. Queries do not change geometry or the timeline.

Primitive and transform/curve-edit previews use the same commands with `preview: true`. Fetch their temporary display with `sketch.getProxy({ preview: true })`; the ordinary query still returns the working sketch. Missing/expired previews fail. `scene.discardPreview()` clears sketch previews as well as body previews.

`face.properties` includes `frame` for planar faces and omits it for curved faces. Frames contain `origin`, `u`, `v`, and `normal`; vectors are orthonormal and coordinates use millimetres.

## Verification

- A cylinder’s side triangles map to its queried cylindrical face. Its circular rims have closed, distinct edge ranges.
- A rectangle extrusion has matching preview and committed geometry. A replacement, cancel, model change, or another connection cannot retrieve an expired or foreign preview shape.
- A cut can replace or hide a body in the preview while its committed proxy remains accessible. After a batch of ten operations, the client can request only the final present bodies.
