# Integrate the JavaScript SDK

Use `@pamatcad/sdk` to send modeling commands from your application to a running PamatCAD host over WebSocket. This example connects from Node.js, creates a rectangular solid, and reads its volume.

## Build and start the host

From the PamatCAD checkout, run the following with Node.js 24+, Rustup, CMake 3.24+, and a C++ compiler installed.

```sh
npm ci
npm run build
cargo run --locked -p pamatcad-host -- serve --listen 127.0.0.1:8787
```

Keep the host running. Its `ready` message includes the connection URL, `ws://127.0.0.1:8787/rpc` for this address.

## Add the SDK to your application

The PamatCAD workspace already provides `@pamatcad/sdk`. If your application has its own npm project outside the checkout, install the built SDK from its local directory. Run this from your application, substituting the path to your checkout.

```sh
npm install /path/to/pamatcad/sdk/javascript
```

## Create and measure a solid

Save the following as `example.mjs` in your project and run `node example.mjs` in a second terminal.

```js
import { Core } from "@pamatcad/sdk";

const core = await Core.connect("ws://127.0.0.1:8787/rpc");
try {
  const scene = await core.scene.create("First solid", { length: "mm", angle: "deg" });
  const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
  await sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
  await sketch.complete();

  const profile = await sketch.regions.only();
  const feature = await core.solid.extrude(profile, { length1: 15 });
  const body = await scene.bodies.get(feature.newSolids[0].id);
  const { volume } = await body.properties();
  console.log(volume.value, volume.unit);
} finally {
  core.close();
}
```

The 10 × 10 mm profile extruded by 15 mm gives a volume of 1500 mm³, up to floating-point rounding. In an interactive application, keep the connection open across commands and call `core.close()` when the session ends. For the available extents, modes, and results, see [solid.extrude](../../../doc/api/command/solid/extrude/spec.md).
