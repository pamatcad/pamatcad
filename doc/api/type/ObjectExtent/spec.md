# Name

Stopping position on a body

# Short Description

Choose how the end cap meets the selected limiting body.

# Description

Distances are measured forward from the start plane along the extrusion direction.

# Variants

## `closest` — Nearest point

Stop at the nearest forward point on the body. That point can lie outside the profile, so the extrusion can stop before it touches the body.

## `touch` — First contact

Stop when any part of the advancing end cap first touches the body.

## `intersect` — Full intersection

Stop at the first position where the entire end cap lies inside or on the body. If the whole cap cannot fit, the extrusion fails.

## `farthest` — Farthest point

Stop at the farthest forward point on the body, even if that point lies outside the profile.
