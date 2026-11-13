# Body identity after cuts and joins

A body ID identifies a solid in the scene at a given timeline position. PamatCAD assigns IDs to the result of an operation. OCCT supplies the geometry and tracks which faces survive, split, or disappear.

**Cut.** A target that loses material and remains one solid keeps its ID. A fully consumed target leaves the scene. A target that merely touches the cutting tool keeps its ID and is omitted from the result lists.

**Join.** Each merged solid keeps one participating body's ID. For an extrusion from a face, the body owning the profile face keeps its ID if it participates and is the unique source body in that merge. Otherwise the oldest participating body keeps its ID, using original creation order. The other participating bodies leave the scene. A merge can succeed even when it adds no material.

| Result field | Body IDs reported on commit |
| --- | --- |
| `newSolids` | IDs allocated to newly created scene bodies. Temporary extrusion tools have no scene ID. |
| `affectedSolids` | Surviving IDs whose occupied material changes. For cuts and joins, compare the solid cells belonging to each survivor before and after the operation. |
| `removedSolids` | Existing IDs fully consumed by a cut or absorbed by a join. |

Each ID appears in at most one list. Preview reports proposed effects while the scene stays at its current timeline position. Commit applies all effects together. After removal, `scene.bodies.get(id)` fails with `NOT_FOUND`. At a timeline position before removal, the body retains its original ID.
