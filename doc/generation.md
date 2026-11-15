# Documentation generation

There are three types of automatically generated documentation - API/SDK documentation, user documentation and the in-SDK documentation to use in editors.

`src/core/src/protocol.rs` is the main source of truth for the generation.

# Additional documentation

Commands try to auto-pick documentation form certain paths. See the mappign below:

- commands: `doc/api/command/<section>/<command>/spec.md`, capturing **Name**, **Short Description**, **Description** and **Topology** headers.
- API types: `doc/api/type/<className>/spec.md`, capturing **Name**, **Short Description** and **Description** headers.

Some images may be present alongside `spec.md`. `icon.svg` (32x32) can be used as a toolbar or action icon, and `illustration.svg` (512x256) can be used in editor as an illustration for a command or an action.

Additional references, encountered in markdown, will be added to the generated documentation.

# API/SDK documentation

Rendered in sdk/docs. Generic documentation with different examples for each available SDK languages. Build via `npm run build:api-docs`.

Additional, language specific files are picked from `sdk/<language>/docs/**/*.md`. 
