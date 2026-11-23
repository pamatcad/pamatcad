import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const editorRequire = createRequire(new URL("../../apps/editor/package.json", import.meta.url));
const { createServer } = await import(editorRequire.resolve("vite"));

// Use source modules to replace the shared theme without exposing a test API in the editor.
export async function testEditorTheme(browser) {
  const server = await createServer({
    root: resolve("apps/editor"),
    configFile: resolve("apps/editor/vite.config.ts"),
    mode: "web",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
  try {
    await server.listen();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:" + server.httpServer.address().port);
    await page.addScriptTag({ path: "tests/editor/rectangle.js" });
    await page.evaluate(() => testRectangleEditor());
    await page.getByRole("button", { name: "Body 1", exact: true }).click();
    const popupOpened = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Pop out", exact: true }).click();
    const popup = await popupOpened;
    const panel = popup.locator("#output-dock");
    await panel.waitFor();
    await popup.waitForFunction(() => getComputedStyle(document.querySelector("#output-dock")).display === "flex");
    await popup.locator("#js").focus();
    assert.equal(await popup.locator("#js").evaluate(el => getComputedStyle(el).outlineStyle), "none");

    const commands = await popup.locator("#log summary").count();
    const view = await page.locator("#model-canvas").boundingBox();
    const modelClip = { x: view.x + view.width / 2 - 80, y: view.y + view.height / 2 - 80, width: 160, height: 160 };
    const gizmoClip = { x: view.x + view.width - 120, y: view.y, width: 120, height: 120 };
    const model = await page.screenshot({ clip: modelClip });
    const gizmo = await page.screenshot({ clip: gizmoClip });
    const setTheme = (alternate) => page.evaluate(async (alternate) => {
      const { editorTheme, lightTheme } = await import("/src/theme.ts");
      editorTheme.set(alternate ? {
        ...lightTheme,
        colors: {
          ...lightTheme.colors,
          foreground: "#eeeeee", panelBackground: "#222222", background: "#111111",
          surface: "#995533", selection: "#ff8844", preview: "#cc4488", edge: "#eeeeee",
          sketch: "#bb7799", sketchEdge: "#dd99bb", sketchHighlight: "#ffccdd",
          grid: "#333333", gridMajor: "#666666", axisX: "#ff0000", axisY: "#00ff00", axisZ: "#0088ff",
        },
        opacity: { ...lightTheme.opacity, preview: 0.5, disabled: 0.6, occluded: 0.15 },
      } : lightTheme);
    }, alternate);
    await setTheme(true);
    for (const selector of ["#home", "#camera-mode", "#scene-browser", ".ribbon"]) {
      assert.equal(await page.locator(selector).evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(34, 34, 34)");
    }
    assert.equal(await panel.evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(34, 34, 34)");
    assert.equal(await panel.evaluate((el) => getComputedStyle(el).color), "rgb(238, 238, 238)");
    assert.equal(await page.locator("#object-list .tree-expand:disabled").first().evaluate((el) => getComputedStyle(el).opacity), "0.6");
    assert.ok(!(await page.screenshot({ clip: modelClip })).equals(model), "Recolor the existing selected body");
    assert.ok(!(await page.screenshot({ clip: gizmoClip })).equals(gizmo), "Repaint cube and axis labels");
    assert.equal(await popup.locator("#log summary").count(), commands, "Theme changes must not call the core or request proxies");
    await setTheme(false);
    assert.ok((await page.screenshot({ clip: modelClip })).equals(model), "Restore the existing body, selection and framing");
    assert.ok((await page.screenshot({ clip: gizmoClip })).equals(gizmo), "Restore cube and axis textures");

    // Existing sketch and preview materials also need to respond, with no new core calls.
    await popup.getByRole("button", { name: "Dock back", exact: true }).click();
    await page.locator("#output-dock").waitFor();
    await page.getByRole("tab", { name: "Sketches", exact: true }).click();
    await page.getByRole("button", { name: "Show Sketch 1", exact: true }).click();
    await page.getByRole("button", { name: "Sketch 1", exact: true }).click();
    const sketchView = await page.locator("#model-canvas").screenshot();
    await setTheme(true);
    assert.ok(!(await page.locator("#model-canvas").screenshot()).equals(sketchView), "Recolor existing sketch profiles and boundaries");
    await setTheme(false);
    assert.ok((await page.locator("#model-canvas").screenshot()).equals(sketchView), "Keep sketch selection after a theme round trip");
    await page.getByRole("button", { name: "Extrude", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("#apply").disabled);
    const preview = await page.screenshot({ clip: modelClip });
    const previewCommands = await page.locator("#log summary").count();
    await setTheme(true);
    assert.ok(!(await page.screenshot({ clip: modelClip })).equals(preview));
    await setTheme(false);
    assert.ok((await page.screenshot({ clip: modelClip })).equals(preview), "Restore cached preview without recomputing it");
    assert.equal(await page.locator("#log summary").count(), previewCommands);
    assert.equal(await page.locator("#features li").count(), 2);
    assert.deepEqual(errors, []);
    console.log("Live theme updates, detached console, selected bodies and sketches, preview, and theme round trip passed");
  } finally {
    await context.close();
    await server.close();
  }
}
