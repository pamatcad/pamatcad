# Building

Requires Node.js 24+, Rustup, CMake 3.24+, and a C++ compiler (macOS: Xcode Command Line Tools; Linux: GCC/Clang and Make; Windows: Visual Studio C++ Build Tools).

```sh
npm ci
npm test
```

The first build downloads the pinned Rust toolchain and OCCT 8.0.1, builds OCCT, and generates SDK types from Rust. Later builds reuse Cargo/CMake caches; OCCT version changes trigger a fresh kernel build. No system OCCT installation or manual compiler flags are needed.

`npm test` builds the native core and JavaScript SDK and runs every test under `tests/sdk/javascript/api/`, including nested folders. Put shared helpers in `tests/sdk/javascript/support/`. The extrusion test uses the compiled SDK and a real WebSocket server to check that the resulting body has a volume of 1500 mm³.

Run `npm test -- --report` for an offline HTML overview. Open the printed `reports/tests/<run>/index.html` path. Each test with a solid scene gets a JPEG of its final committed geometry and a STEP download. Keep the `assets/` directory beside the HTML when sharing the report.

The same exports are available to SDK callers through `scene.export({ format: "step" })` and `scene.capture({ format: "jpeg" })`. Both return `{ bytes, mediaType }` and accept an optional `bodies` array of body references. Capture defaults to a 1200 × 900 orthographic view from the (1, 1, 1) direction toward the world origin, with Z up and 32 px padding.

To build without testing: `npm run build`. To run the server:

```sh
cargo run --locked -p pamatcad-host -- serve --listen 127.0.0.1:8787
```
