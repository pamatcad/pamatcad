# Name

Close scene

# Short Description

Release a scene and its geometry from the engine.

# Description

Closes the specified scene, including its timeline, sketches, bodies and all session previews. Existing references to the scene become invalid. Other scenes and the connection remain available.

# Scope

Scene lifecycle.

# Intent

Release engine resources when a document is closed.

# Inputs

An existing scene ID.

# Parameters

`sceneId`: the scene to close.

# Preview, results and effects

Returns no value. Removes the scene and its previews from every session. Does not create a timeline entry.

# Topology and references

All references into the closed scene expire.

# Errors

`NOT_FOUND` if the scene does not exist, including repeated close calls. Preview lookups after closing fail with `PREVIEW_UNAVAILABLE`.

# Test cases

- Close a scene containing a body and previews from two sessions. Its timeline, body and sketch references become invalid; both previews become unavailable. A second scene retains its body, volume and timeline, and can still be edited.
- Closing the scene again fails with `NOT_FOUND`. Creating another scene does not reuse the closed scene's ID.

# History

Implemented for editor document tabs.
