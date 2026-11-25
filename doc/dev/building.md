# Building

Requires Node.js 24+, Rustup, CMake 3.24+, and a C++ compiler (macOS: Xcode Command Line Tools; Linux: GCC/Clang and Make; Windows: Visual Studio C++ Build Tools).

```sh
npm ci
npm test
```

The first build downloads the pinned Rust toolchain and OCCT 8.0.1, builds OCCT, and generates SDK types from Rust. Later builds reuse Cargo/CMake caches; OCCT version changes trigger a fresh kernel build. No system OCCT installation or manual compiler flags are needed.

`VERSION` is the release version source. After editing it, run `npm run version:sync` and commit the updated manifests and lockfiles. Run `npm run version:check` locally or in CI to detect mismatches without changing files. The editor reads `VERSION` directly; desktop bundles inherit the synchronized Cargo version. Builds do not synchronize versions automatically.

`npm test` builds the native core and JavaScript SDK and runs every test under `tests/api/`, including nested folders. Put shared helpers in `tests/support/`. The extrusion test uses the compiled SDK and a real WebSocket server to check that the resulting body has a volume of 1500 mm³.

Run `npm test -- --report` for an offline HTML overview. Open the printed `reports/tests/<run>/index.html` path. Each test with a solid scene gets a JPEG of its final committed geometry and a STEP download. Keep the `assets/` directory beside the HTML when sharing the report.

Performance tests are separate and opt-in: `npm run test:performance` (native) or `npm run test:performance -- --runtime wasm`. They are excluded from normal test commands and routine feature validation. See [Performance testing](performance.md).

The same exports are available to SDK callers through `scene.export({ format: "step" })` and `scene.capture({ format: "jpeg" })`. Both return `{ bytes, mediaType }` and accept an optional `bodies` array of body references. Capture defaults to a 1200 × 900 orthographic view from the (1, 1, 1) direction toward the world origin, with Z up and 32 px padding.

Run `npm run build:api-docs` to generate the offline SDK reference. Open `build/api-docs/index.html` or serve the whole `build/api-docs/` directory. The build reads SDK declarations and the `Name`, `Short Description`, and `Description` sections of `doc/api/<kind>/<symbol>/spec.md`. An optional `# Topology` section appears after Description. Relative links to Markdown files under `doc/` open offline in the reference. Command folders use the dotted method name as a path, for example `command/solid/extrude`. Classes and types use their declaration names, for example `type/Formula`.

Run `npm run build:user-docs` for the user guide at `build/user-docs/index.html`. Its [authoring conventions](../generation.md#user-documentation) describe the landing page and operation choices.

Add language-specific guides as Markdown under `sdk/<language>/docs/`, including subdirectories. The first `#` heading gives the title in **Guides** and search. Use relative Markdown links to other guides or API specs, as in the [JavaScript integration guide](../../sdk/javascript/docs/integration.md).

To build without testing: `npm run build`. To run the server:

```sh
cargo run --locked -p pamatcad-host -- serve --listen 127.0.0.1:8787
```

## Editor

Run `npm ci` from the repository root. Both editors use the JavaScript SDK and the same Rust and OCCT engine.

### Browser

Install Emscripten 4.0.23 once. The build finds it in `target/emsdk` or through an activated Emscripten environment.

```sh
git clone --depth 1 --branch 4.0.23 https://github.com/emscripten-core/emsdk.git target/emsdk
target/emsdk/emsdk install 4.0.23
target/emsdk/emsdk activate 4.0.23
rustup target add wasm32-unknown-emscripten
npm run build:web
npm run dev:editor
```

Open the URL printed by Vite. To deploy the production build, serve `build/web/` over HTTP(S), including the `wasm/` folder. The browser runs the kernel in a worker. Changes to editor code reload during development. Rebuild the WASM module after changing the kernel. `PAMATCAD_BUILD_JOBS` sets the number of OCCT compile jobs for the first build.

### Standalone

Run `npm run dev:desktop` to rebuild the SDK and desktop UI, then launch the app with `tauri dev`. Rust changes rebuild automatically; rerun the command after frontend changes.

Run `npm run build:desktop` with the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) installed. On macOS, open `apps/editor/src-tauri/target/release/bundle/macos/PamatCAD.app`. This builds a locally ad-hoc signed application. The editor sends commands directly to the native engine. Installed fonts are discovered through the OS using `font-kit`; Linux builds also require the Fontconfig and FreeType development packages.

### UI tests

Run `npm run test:editor:web` after the web build (installed Chrome, or set `CHROME_BIN` to a Chromium executable). Run `npm run test:editor:desktop` after building the SDK. Both checks operate the editor controls and use the console to measure the finished body.
