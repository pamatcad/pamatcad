import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { testSketchConstructors } from "./sketch-geometry.mjs";
import { testInteractiveUpdates } from "./interactive-updates.mjs";
import { testNavigation } from "./navigation.mjs";
import { testSketchDragging } from "./sketch-drag.mjs";
import { testSketchUpdates } from "./sketch-updates.mjs";

const require = createRequire(new URL("../../apps/editor/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));

export async function testToolInputs(browser) {
  const server = await createServer({ root: resolve("apps/editor"), configFile: resolve("apps/editor/vite.config.ts"),
    mode: "web", server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  const page = await browser.newPage();
  try {
    await server.listen();
    await page.goto("http://127.0.0.1:" + server.httpServer.address().port);
    const result = await page.evaluate(async (sdk) => {
      const { Core } = await import(sdk);
      const { editorTransport } = await import("/src/runtime/transport.ts");
      const { FormulaInput, lengthStep } = await import("/src/formula-input.ts");
      const core = new Core(editorTransport(() => {}));
      const scene = await core.scene.create("Input units", { length: "in", angle: "rad" });
      const container = document.createElement("div");
      document.body.append(container);
      const input = document.createElement("input");
      input.id = "test-formula";
      container.append(input);
      try {
        const length = new FormulaInput(input, "length", scene, () => {});
        input.value = "(1/8) in";
        const evaluated = await length.evaluate();
        length.setFromHandle(6.35);
        const text = input.value;
        const selection = [input.selectionStart, input.selectionEnd];
        const angleInput = document.createElement("input");
        angleInput.id = "test-angle";
        container.append(angleInput);
        const angle = new FormulaInput(angleInput, "angle", scene, () => {});
        angle.setFromHandle(5);
        const angleText = angleInput.value;
        const degrees = await angle.evaluate();
        return { evaluated, text, selection, angleText, degrees, steps: [
          lengthStep(0.1, 800, "mm", 30), lengthStep(0.001, 800, "mm", 0.3),
          lengthStep(25.4 / 128, 800, "in", 25.4), lengthStep(25.4 / 256, 800, "in", 25.4),
          lengthStep(25.4 * 2.5 / 16, 800, "in", 25.4 * 20),
        ] };
      } finally { container.remove(); await scene.close(); core.close(); }
    }, "/@fs" + resolve("sdk/javascript/dist/index.js"));
    assert.ok(Math.abs(result.evaluated - 3.175) < 1e-12);
    assert.equal(result.text, "0.25 in");
    assert.deepEqual(result.selection, [0, result.text.length]);
    assert.match(result.angleText, / rad$/);
    assert.ok(Math.abs(parseFloat(result.angleText) - Math.PI / 36) < 1e-12);
    assert.ok(Math.abs(result.degrees - 5) < 1e-10);
    assert.deepEqual(result.steps, [2, 0.02, 25.4 / 8, 25.4 / 16, 25.4 * 2.5]);
    console.log("Formula fields: inch/radian evaluation, explicit-unit drag values, selection, and scale-dependent snapping passed");
    await testSketchConstructors(page, "/@fs" + resolve("sdk/javascript/dist/index.js"));
    await testInteractiveUpdates(page, "/@fs" + resolve("sdk/javascript/dist/index.js"));
    await testNavigation(page);
    await testSketchDragging(page);
    await testSketchUpdates(page);
  } finally { await page.close(); await server.close(); }
}
