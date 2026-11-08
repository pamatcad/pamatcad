# Building

Requires Node.js 24+, Rustup, CMake 3.24+, and a C++ compiler (macOS: Xcode Command Line Tools; Linux: GCC/Clang and Make; Windows: Visual Studio C++ Build Tools).

```sh
npm ci
npm test
```

The first build downloads the pinned Rust toolchain and OCCT 8.0.1, builds OCCT, and generates SDK types from Rust. Later builds reuse Cargo/CMake caches; OCCT version changes trigger a fresh kernel build. No system OCCT installation or manual compiler flags are needed.

`npm test` builds the native core and JavaScript SDK and runs every test under `tests/sdk/javascript/api/`, including nested folders. Put shared helpers in `tests/sdk/javascript/support/`. The extrusion test uses the compiled SDK and a real WebSocket server to check that the resulting body has a volume of 1500 mm³.

To build without testing: `npm run build`. To run the server:

```sh
cargo run --locked -p pamatcad-host -- serve --listen 127.0.0.1:8787
```

The SDK tests cover a rectangular extrusion and a blind circular cut on its end face. See the [extrusion spec](../command/solid/extrude/spec.md) for parameters and limits. Intersecting, touching, or nested sketch profiles are rejected. Constraint solving, feature editing/recomputation, saved documents, desktop UI, and WASM are not implemented yet.
