import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function testSketchText(page) {
  await page.getByText("File", { exact: true }).click(); await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled && !document.querySelector("#features").children.length);
  await page.evaluate(async () => {
    window.fontAccessDescriptor = Object.getOwnPropertyDescriptor(window, "queryLocalFonts");
    Object.defineProperty(window, "queryLocalFonts", { configurable: true, value: undefined });
    const { SketchTool } = await import("/src/tools/sketch.ts"), start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) { window.textCheck = { tool: this, viewport: this.viewport }; return start.apply(this, args); };
    try { document.querySelector("#new-sketch").click(); } finally { SketchTool.prototype.start = start; }
  });
  const idle = () => page.waitForFunction(() => {
    const t = window.textCheck.tool; return t.sketch && !t.pending && !t.updateRunning && !t.creating && !t.viewport.renderPending;
  });
  const screen = point => page.evaluate(point => {
    const v = window.textCheck.viewport, rect = document.querySelector("#model-canvas").getBoundingClientRect();
    const p = v.camera.position.clone().fromArray([...point, 0]).project(v.camera);
    return [rect.x + (p.x + 1) * rect.width / 2, rect.y + (1 - p.y) * rect.height / 2];
  }, point);
  try {
    await page.evaluate(async () => { const t = window.textCheck.tool; await t.setSupport(t.scene.construction.builtin.planes.xy); });
    await idle();
    await page.locator('[data-tool="text"]').click();
    assert.equal(await page.locator("#sketch-text").evaluate(e => e.tagName), "TEXTAREA");
    assert.ok(await page.locator("#sketch-text").evaluate(e => e.rows >= 4));
    assert.deepEqual(await page.locator("#sketch-font-family option").allTextContents(), ["Roboto"]);
    assert.equal(await page.locator("#sketch-font-help").getAttribute("title"), "This browser does not support access to installed fonts. Use Chrome to select a local font.");
    assert.ok(await page.locator("#sketch-font-help").isVisible());
    assert.equal(await page.locator("#sketch-local-fonts").isVisible(), false);
    assert.ok(await page.locator("#sketch-size").inputValue().then(s => s.endsWith(" mm")));
    assert.equal(await page.locator("#sketch-guide").count(), 0);
    assert.ok(await page.locator("#sketch-highlight").evaluate(e => !!(document.querySelector("#sketch-config").compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)));
    assert.equal(await page.locator("#sketch-horizontal button svg path[class], #sketch-vertical button svg path[class]").count(), 7);
    assert.ok(await page.getByRole("button", { name: "Italic", exact: true }).isDisabled());
    await page.getByRole("button", { name: "Bold", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#sketch-weight").value === "700");
    await page.locator("#sketch-weight").selectOption("400");
    assert.equal(await page.getByRole("button", { name: "Bold", exact: true }).getAttribute("aria-pressed"), "false");
    await page.locator("#sketch-text").fill("B");
    await page.locator("#sketch-text").press("Enter");
    assert.equal(await page.locator("#sketch-text").inputValue(), "B\n");
    assert.equal(await page.evaluate(() => window.textCheck.tool.state.texts.length), 0);
    await page.locator("#sketch-text").fill("B");
    await page.locator("#sketch-size").fill("20 mm / 2");
    await page.mouse.click(...await screen([-15, 0])); await idle();
    let text = await page.evaluate(() => window.textCheck.tool.state.texts[0]);
    const frame = text.frame;
    assert.equal(Object.keys(frame).length, 11);
    assert.equal(text.parameters.text, "B"); assert.equal(text.parameters.size.expression, "20 mm / 2");
    assert.ok(await page.evaluate(() => window.textCheck.tool.proxy.regions.some(r => r.holes.length === 2)));
    await page.keyboard.press("Escape");
    await page.mouse.dblclick(...await screen([-15, 0])); await idle();
    assert.ok(await page.locator("#sketch-text-edit-actions").isVisible());
    assert.ok(await page.locator("#apply").isDisabled());
    await page.locator("#sketch-text").fill("B\nB"); await idle();
    assert.equal(await page.evaluate(() => window.textCheck.tool.state.texts[0].parameters.text), "B", "Typing previews the edit without changing the working text");
    await page.getByRole("button", { name: "Align center", exact: true }).click();
    await page.getByRole("button", { name: "Align top", exact: true }).click(); await idle();
    await page.locator(".sketch-fields").evaluate(e => e.scrollTop = 0);
    await page.screenshot({ path: "/private/tmp/pamatcad-text-panel.png" });
    await page.locator("#sketch-text-done").click(); await idle();
    text = await page.evaluate(() => window.textCheck.tool.state.texts[0]);
    assert.equal(text.parameters.text, "B\nB"); assert.equal(text.parameters.horizontal, "center"); assert.equal(text.parameters.vertical, "top");
    const id = text.id;
    await page.mouse.dblclick(...await screen([-15, 0])); await idle();
    await page.locator("#sketch-text").fill("Discard me"); await idle();
    await page.locator("#sketch-text-cancel").click(); await idle();
    assert.equal(await page.evaluate(() => window.textCheck.tool.state.texts[0].parameters.text), "B\nB");
    const from = await screen([-15, 0]), to = await screen([-10, 5]);
    await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps: 5 }); await page.mouse.up(); await idle();
    text = await page.evaluate(() => window.textCheck.tool.state.texts[0]);
    // PointerEvent screen coordinates are quantized by the browser; use 1/1000 of a pixel.
    const tolerance = await page.evaluate(() => window.textCheck.viewport.pixelLength / 1000);
    assert.ok(Math.abs(text.parameters.origin[0] + 10) < tolerance, JSON.stringify(text.parameters.origin)); assert.ok(Math.abs(text.parameters.origin[1] - 5) < tolerance, JSON.stringify(text.parameters.origin));
    assert.equal(text.id, id);
    assert.deepEqual(text.frame, frame, "Text edits keep frame references");
    const framePoint = key => page.evaluate(key => {
      const state = window.textCheck.tool.state, frame = state.texts[0].frame;
      return state.entities.find(e => e.reference.id === frame[key].id).geometry.position;
    }, key);
    const corner = await framePoint("bottomLeft");
    await page.mouse.click(...await screen(corner)); await idle();
    assert.ok(await page.evaluate(() => {
      const t = window.textCheck.tool; return t.selected.has(t.state.texts[0].frame.bottomLeft.id);
    }), "Frame corners are selectable as constraint references");
    assert.ok(await page.locator('#sketch-construction button').evaluateAll(buttons => buttons.every(b => b.disabled)));
    const snapped = await page.evaluate(corner => window.textCheck.tool.snapped(corner), corner);
    assert.deepEqual(snapped, corner, "Frame corners are snap targets");
    const style = await page.evaluate(() => {
      const { tool, viewport } = window.textCheck, frame = tool.state.texts[0].frame;
      const line = viewport.sketchDisplay.children.find(c => c.isLineSegments2 && c.userData.pick?.id === frame.diagonal1.id);
      return { dashed: line.material.dashed, color: line.material.color.getHexString(), expected: viewport.theme.colors.partiallyConstrained.replace("#", "") };
    });
    assert.ok(style.dashed); assert.equal(style.color, style.expected);
    const cornerScreen = await screen(corner), attempt = await screen([corner[0] - 3, corner[1] - 3]);
    await page.mouse.move(...cornerScreen); await page.mouse.down(); await page.mouse.move(...attempt, { steps: 3 }); await page.mouse.up(); await idle();
    assert.deepEqual(await framePoint("bottomLeft"), corner, "Dragging a corner cannot deform the frame");
    await page.keyboard.press("Escape");
    const center = await framePoint("center");
    await page.locator('[data-constraint="fix"]').click();
    await page.mouse.click(...await screen(center)); await idle(); await page.keyboard.press("Escape");
    const fixed = await page.evaluate(() => window.textCheck.tool.state.constraints.find(c => c.kind === "fix"));
    assert.ok(fixed.parameters.points.some(r => r.id === frame.center.id));
    await page.mouse.dblclick(...await screen([-10, 5])); await idle();
    await page.locator("#sketch-text").fill("B\nB "); await idle();
    await page.locator("#sketch-text-done").click(); await idle();
    assert.deepEqual((await page.evaluate(() => window.textCheck.tool.state.texts[0])).frame, frame);
    const afterCenter = await framePoint("center");
    assert.ok(Math.hypot(...afterCenter.map((v, i) => v - center[i])) < tolerance);
    text = await page.evaluate(() => window.textCheck.tool.state.texts[0]);
    const originBeforeDrag = text.parameters.origin;
    await page.mouse.move(...await screen(originBeforeDrag)); await page.mouse.down();
    await page.mouse.move(...await screen([originBeforeDrag[0] + 5, originBeforeDrag[1] + 5]), { steps: 3 }); await page.mouse.up(); await idle();
    text = await page.evaluate(() => window.textCheck.tool.state.texts[0]);
    assert.ok(Math.hypot(...text.parameters.origin.map((v, i) => v - originBeforeDrag[i])) < tolerance, "Whole-text drag respects the fixed frame center");
    await page.screenshot({ path: "/private/tmp/pamatcad-text-frame.png" });
    const regions = await page.evaluate(() => window.textCheck.tool.proxy.regions);
    await page.mouse.click(...await screen(text.parameters.origin), { button: "right" });
    await page.getByRole("button", { name: "Convert to sketch geometry", exact: true }).click(); await idle();
    assert.deepEqual(await page.evaluate(() => window.textCheck.tool.state.texts), []);
    assert.deepEqual(await page.evaluate(() => window.textCheck.tool.proxy.regions), regions);
    assert.ok(await page.evaluate(id => window.textCheck.tool.state.constraints.some(c => c.id === id), fixed.id));
    await page.locator('[data-tool="text"]').click();
    await page.locator("#sketch-font").setInputFiles({ name: "Roboto.ttf", mimeType: "font/ttf", buffer: await readFile("native/sketch/fonts/Roboto.ttf") });
    await page.waitForFunction(() => window.textCheck.tool.textControls.face.id.startsWith("imported:"));
    await page.locator("#sketch-text").fill("O");
    await page.locator("#sketch-size").fill("5 mm");
    await page.mouse.click(...await screen([10, 10])); await idle();
    text = await page.evaluate(() => window.textCheck.tool.state.texts[0]);
    assert.ok(text.parameters.fontBase64.length > 1000);
    assert.equal(text.parameters.fontIndex, 0);
    await page.keyboard.press("Escape");
    await page.locator("#apply").click();
    await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
    console.log("Editable text: controls, unsupported-font tooltip, formulas, regions, double-click, cancel, dragging, conversion and font import passed");

    // Permission denial must not be mislabeled as an unsupported browser.
    await page.evaluate(() => Object.defineProperty(window, "queryLocalFonts", { configurable: true, value: async () => { throw new DOMException("Denied", "NotAllowedError"); } }));
    await page.locator("#new-sketch").click();
    await page.evaluate(() => chooseSketchPlane("XY"));
    await page.waitForFunction(() => !document.querySelector("#apply").disabled);
    await page.locator('[data-tool="text"]').click();
    await page.locator("#sketch-local-fonts").click();
    await page.waitForFunction(() => !document.querySelector("#sketch-font-help").hidden);
    assert.match(await page.locator("#sketch-font-help").getAttribute("title"), /denied or blocked/);
    await page.locator("#cancel").click();
  } finally {
    await page.evaluate(() => {
      if (window.fontAccessDescriptor) Object.defineProperty(window, "queryLocalFonts", window.fontAccessDescriptor);
      else delete window.queryLocalFonts;
    });
  }
}
