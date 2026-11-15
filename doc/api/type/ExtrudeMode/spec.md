# Name

Extrusion result

# Short Description

Choose what happens to the extruded material.

# Description

For a cut or join, select target bodies to limit which solids can change.

# Variants

## `newBody` — New body

Create a separate solid. Disconnected profiles can create several solids.

## `cut` — Cut

Remove the extruded volume from the target bodies. A body disappears if the cut removes all of its material.

## `join` — Join

Add the extruded volume to the bodies it meets. A join can merge several bodies into one.
