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

Rendered in `build/api-docs/`. Generic documentation with different examples for each available SDK languages. Build via `npm run build:api-docs`.

Additional, language specific files are picked from `sdk/<language>/docs/**/*.md`. 

# User documentation

Run `npm run build:user-docs` and open `build/user-docs/index.html`. Edit `doc/user/index.md` to set the homepage layout. A marker such as `<!-- commands: solid -->` lists the documented commands in that area, using each command's name, short description, and icon.

Each operation page uses the command spec, its adjacent artwork, and optional `user-parameters.md`. The first paragraph of Description is visible on opening the page. Readers can expand the full description and topology.

To describe choices once, add `# Variants` to the corresponding type spec. Give each choice a heading such as `` ## `touch` — First contact `` followed by its explanation. The build checks the keys against the protocol. In parameter or variant prose, a Markdown link on its own line to a type's `spec.md#variants` expands those choices in the user guide. The API reference shows their keys and labels. See the [Extrude parameters](api/command/solid/extrude/user-parameters.md) and [ObjectExtent choices](api/type/ObjectExtent/spec.md#variants).
