# Name

Extrusion sides

# Short Description

Choose how the solid extends from its start plane.

# Description

One-sided and two-sided extrusions can use a distance, pass through all target bodies, or end at a selected body. Symmetric extrusions use a distance.

# Variants

## `oneSide` — One side

Extrude in one direction. Choose how far that side extends.

[Side 1 end condition](../ExtrudeExtent/spec.md#variants)

## `twoSides` — Two sides

Extrude in opposite directions. Set the end condition and taper independently for each side.

[Side 1 end condition](../ExtrudeExtent/spec.md#variants)

[Side 2 end condition](../ExtrudeExtent/spec.md#variants)

## `symmetric` — Symmetric

Extend equally in both directions, using the same taper. Choose **Total length** to divide the entered distance between the sides, or **Half-length** to apply that distance to each side.
