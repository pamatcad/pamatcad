# Building

Requires Node.js 24+, Rustup, CMake 3.24+, and a C++ compiler (macOS: Xcode Command Line Tools; Linux: GCC/Clang and Make; Windows: Visual Studio C++ Build Tools).

```sh
npm ci
npm test
```

The first build downloads the pinned Rust toolchain and OCCT 8.0.1, builds OCCT, and generates SDK types from Rust. Later builds reuse Cargo/CMake caches; OCCT version changes trigger a fresh kernel build. No system OCCT installation or manual compiler flags are needed.

`npm test` builds the native core and JavaScript SDK and runs every test under `tests/api/`, including nested folders. Put shared helpers in `tests/support/`. The extrusion test uses the compiled SDK and a real WebSocket server to check that the resulting body has a volume of 1500 mm³.

Run `npm test -- --report` for an offline HTML overview. Open the printed `reports/tests/<run>/index.html` path. Each test with a solid scene gets a JPEG of its final committed geometry and a STEP download. Keep the `assets/` directory beside the HTML when sharing the report.

The same exports are available to SDK callers through `scene.export({ format: "step" })` and `scene.capture({ format: "jpeg" })`. Both return `{ bytes, mediaType }` and accept an optional `bodies` array of body references. Capture defaults to a 1200 × 900 orthographic view from the (1, 1, 1) direction toward the world origin, with Z up and 32 px padding.

Run `npm run build:docs` to generate the offline SDK reference. Open `sdk/docs/index.html` or serve the whole `sdk/docs/` directory. The build reads SDK declarations and the `Name`, `Short Description`, and `Description` sections of `doc/api/<kind>/<symbol>/spec.md`. An optional `# Topology` section appears after Description. Relative links to Markdown files under `doc/` open offline in the reference. Command folders use the dotted method name as a path, for example `command/solid/extrude`. Classes and types use their declaration names, for example `type/Formula`.

Add language-specific guides as Markdown under `sdk/<language>/docs/`, including subdirectories. The first `#` heading gives the title in **Guides** and search. Use relative Markdown links to other guides or API specs, as in the [JavaScript integration guide](../../sdk/javascript/docs/integration.md).

To build without testing: `npm run build`. To run the server:

```sh
cargo run --locked -p pamatcad-host -- serve --listen 127.0.0.1:8787
```
