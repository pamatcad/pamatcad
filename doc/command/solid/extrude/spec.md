# Scope

Basic extrusion operation for solids

# Intent

Extrude operation takes a 2D profile (or co-planar profiles) and extrudes it along a normal direction to create a prism-like solid.

# Inputs

Select one or more regions of the same sketch or one or more coplanar planar faces.

Extrusion, by default, affects all bodies on the way of extrusion. Supply `targets` to restrict it to specific bodies.

# Parameters

- `length` is measured in mm along the profile normal. Negative length is accepted.
- `mode` defaults to `"newBody"`, which requires positive length. `"cut"` accepts signed length. 
- 
TK: default mode should be resolved after extrusion

# Preview, results and effects

- `newSolids` - newly created bodies
- `affectedSolids` - existing bodies with changed geometry

# Topology and references

TK

# Errors

- `INVALID_PARAMETER` for invalid dimensions, invalid target selection, or a cut that removes no material.
- `NOT_FOUND` for a missing referenced body, profile, or end cap. `AMBIGUOUS_FACE` if the cap has multiple descendants.
- `KERNEL_FAILURE` if the cut fails validation, splits a target, or consumes it entirely.

# Test cases

- Cube extrusion: extrude a 10 × 10 mm rectangle by 15 mm. Expect one new solid with a volume of 1500 mm³.
- Cube with hole: extrude a 10 × 10 mm rectangle by 10 mm. Sketch a centered circle of diameter 8 mm on the top face. Cut by −5 mm. Expect volume (1000 − 80π) mm³, an empty `newSolids` array, and the original cube as the sole member of `affectedSolids`.
- Multiple profiles, cut with skips: on XY, draw three 10 × 10 mm squares centered at X = −20, 0, and 20 mm, Y = 0. Extrude all three regions by 10 mm in one command. Expect two timeline entries and three cubes. On the left cube’s outward −X face, sketch a centered circle of diameter 5 mm. Preview a −50 mm cut: expect three affected bodies, three timeline entries, and all three committed volumes still 1000 mm³. From the preview results, target only the two outer cubes and commit the cut. Expect four timeline entries, no new solids, both outer volumes (1000 − 62.5π) mm³, and the middle volume 1000 mm³.

TK: face extrude, join extrude, diff extrude, offset, offset from, to object, through all

# History

- 08 Nov 2026: initial implementation
