import assert from "node:assert/strict";

export async function testExtrudeEditor(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector("#new-sketch") && !document.querySelector("#new-sketch").disabled);
    await page.locator("#toggle-output").click();
    let serial = 0;
    const run = async (source) => {
      const marker = "extrude-check-" + ++serial;
      await page.locator("#js").fill(`return { marker: ${JSON.stringify(marker)}, value: await (async () => { ${source} })() };`);
      await page.locator("#js").press("Enter");
      await page.waitForFunction((marker) => !document.querySelector("#js").disabled &&
        document.querySelector("#console-output").lastElementChild?.textContent.includes(marker), marker);
      return JSON.parse(await page.locator("#console-output > :last-child").textContent()).value;
    };
    const fresh = async (script) => {
      await page.getByText("File", { exact: true }).click();
      await page.locator("#menu-new").click();
      await page.waitForFunction(() => !document.querySelector("#js").disabled && !document.querySelector("#features").children.length);
      await run(script);
    };
    const ready = async () => {
      try { await page.waitForFunction(() => document.querySelector("#apply") && !document.querySelector("#apply").disabled); }
      catch (error) { throw new Error(`Extrude preview: ${await page.locator("#status").textContent()}`, { cause: error }); }
    };
    const choose = (id, value) => page.locator("#" + id).selectOption(value);
    const row = (name) => page.locator("#object-list").getByRole("button", { name, exact: true });
    const sketch = async (name = "Sketch 1") => { await page.locator("#sketches-tab").click(); await row(name).click(); };
    const volume = () => run(`const bodies = await scene.bodies.all(); return Promise.all(bodies.map(async b => (await (await scene.bodies.get(b.id)).properties()).volume.value));`);
    const volumes = async (expected) => {
      const actual = await volume();
      assert.equal(actual.length, expected.length);
      expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) < 1e-7, `Volume ${actual[index]} should equal ${value}`));
    };
    const start = async () => { await page.locator("#extrude").click(); await page.locator("#tool-panel").waitFor(); };
    const apply = async () => { await ready(); await page.locator("#apply").click(); await page.waitForFunction(() => !document.querySelector("#js").disabled); };
    const base = `const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
      await s.primitives.add("rectangle", {from:[0,0],to:[10,10]}); await s.complete();`;

    await fresh(`const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
      await s.primitives.add("rectangle", {from:[0,0],to:[10,10]});
      await s.primitives.add("circle", {center:[20,5],diameter:4}); await s.complete();`);
    await start();
    assert.ok(await page.locator("#apply").isDisabled());
    await page.locator("#sketches-tab").click();
    await row("Region 1").click(); await ready();
    await row("Region 2").click({ modifiers: ["Shift"] }); await ready();
    assert.match(await page.locator("#pick-profiles").textContent(), /^2 selected/);
    await row("Region 2").click({ modifiers: ["Shift"] }); await ready();
    assert.match(await page.locator("#pick-profiles").textContent(), /^1 selected/);
    await page.locator("#length").fill("2 deg");
    await page.waitForFunction(() => document.querySelector("#length").getAttribute("aria-invalid") === "true");
    assert.ok(await page.locator("#apply").isDisabled());
    await page.locator("#length").fill("8 / 2"); await ready();
    await page.locator("#length").evaluate((input) => input.setSelectionRange(1, 1));
    await page.keyboard.type("0"); await ready();
    assert.equal(await page.locator("#length").inputValue(), "80 / 2", "Typed formulas keep cursor editing");
    await page.locator("#length").fill("8 / 2"); await ready();
    const handle = page.locator('[data-handle="length"]');
    const h = await handle.boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down(); await page.mouse.move(h.x + h.width / 2, h.y - 60, { steps: 8 }); await page.mouse.up();
    await ready();
    const dragged = await page.locator("#length").inputValue();
    assert.match(dragged, / mm$/);
    assert.notEqual(parseFloat(dragged), 4);
    assert.deepEqual(await page.locator("#length").evaluate((input) => [input.selectionStart, input.selectionEnd]), [0, dragged.length]);
    await page.keyboard.type("6 / 2"); await ready();
    assert.equal(await page.locator("#length").inputValue(), "6 / 2");

    // Rotation and offset controls also update fields; perspective dragging keeps the camera fixed.
    const taper = await page.locator('[data-handle="taper1"]').boundingBox();
    await page.mouse.move(taper.x + taper.width / 2, taper.y + taper.height / 2); await page.mouse.down();
    await page.mouse.move(taper.x + taper.width / 2 + 40, taper.y + taper.height / 2 + 35, { steps: 6 }); await page.mouse.up();
    const angle = await page.locator("#taper1").inputValue();
    assert.match(angle, / deg$/);
    assert.notEqual(parseFloat(angle), 0);
    assert.equal(parseFloat(angle) % 5, 0);
    await page.locator("#taper1").fill("0"); await ready();
    await choose("extrude-start", "offset"); await page.locator("#offset").fill("-3"); await ready();
    const offset = await page.locator('[data-handle="offset"]').boundingBox();
    await page.mouse.move(offset.x + offset.width / 2, offset.y + offset.height / 2); await page.mouse.down();
    await page.mouse.move(offset.x + offset.width / 2, offset.y - 30, { steps: 5 }); await page.mouse.up();
    await ready();
    assert.match(await page.locator("#offset").inputValue(), / mm$/);
    await choose("extrude-start", "profilePlane"); await ready();
    await page.locator("#camera-mode").click(); await page.getByRole("radio", { name: "Perspective", exact: true }).click();
    const perspective = await page.locator('[data-handle="length"]').boundingBox();
    const viewBefore = await page.locator("#model-canvas").boundingBox();
    const cube = { x: viewBefore.x + viewBefore.width - 110, y: viewBefore.y + 5, width: 100, height: 110 };
    const orientation = await page.screenshot({ clip: cube });
    await page.mouse.move(perspective.x + 15, perspective.y + 5); await page.mouse.down();
    await page.mouse.move(perspective.x + 15, perspective.y - 40, { steps: 5 }); await page.mouse.up(); await ready();
    assert.ok((await page.screenshot({ clip: cube })).equals(orientation), "Handle dragging must not orbit the camera");
    await page.locator("#camera-mode").click(); await page.getByRole("radio", { name: "Orthographic", exact: true }).click();

    // Window position and scroll remain inside the viewport.
    const title = await page.locator("#tool-panel h2").boundingBox();
    const before = await page.locator("#tool-panel").boundingBox();
    await page.mouse.move(title.x + 20, title.y + 5); await page.mouse.down();
    await page.mouse.move(title.x - 180, title.y - 80, { steps: 5 }); await page.mouse.up();
    const moved = await page.locator("#tool-panel").boundingBox();
    assert.ok(moved.x < before.x && moved.y < before.y);
    await choose("extrude-start", "offset"); await page.locator("#offset").fill("-3 mm");
    await choose("extrude-type", "twoSides"); await page.locator("#length").fill("7"); await page.locator("#length2").fill("3");
    const draftId = await page.locator('#document-tabs [aria-selected="true"]').getAttribute("data-document");
    await page.getByText("File", { exact: true }).click(); await page.locator("#menu-new").click();
    await page.waitForFunction(() => !document.querySelector("#js").disabled && !document.querySelector("#features").children.length);
    await page.locator(`#document-tabs [data-document="${draftId}"]`).click(); await ready();
    assert.equal(await page.locator("#extrude-type").inputValue(), "twoSides");
    assert.equal(await page.locator("#offset").inputValue(), "-3 mm");
    assert.equal(await page.locator("#length2").inputValue(), "3");
    const restored = await page.locator("#tool-panel").boundingBox();
    assert.equal(restored.x, moved.x); assert.equal(restored.y, moved.y);
    await apply();
    await volumes([1000]);
    const bounds = await run(`const p = await scene.getProxyFor((await scene.bodies.all())[0]); const z = [...p.positions].filter((_,i)=>i%3===2); return [Math.min(...z), Math.max(...z)];`);
    assert.deepEqual(bounds, [-6, 4]);

    for (const half of ["total", "half"]) {
      await fresh(base); await sketch(); await start();
      await choose("extrude-type", "symmetric"); await choose("symmetric-length", half);
      await page.locator("#length").fill("8"); await apply();
      await volumes([half === "total" ? 800 : 1600]);
    }

    // Pick a preselected planar cap through the actual canvas and join outward.
    await fresh(base + `await core.solid.extrude(await s.regions.only(), {length1:10});`);
    await page.locator("#home").click();
    let view = await page.locator("#model-canvas").boundingBox();
    await page.mouse.click(view.x + view.width - 60, view.y + 38);
    await page.mouse.click(view.x + view.width / 2, view.y + view.height / 2);
    assert.equal(await page.locator("#status").textContent(), "Face selected");
    await start(); await choose("extrude-mode", "join"); await page.locator("#length").fill("5"); await apply();
    await volumes([1500]);

    // Restrict a through-all cut to one of two aligned bodies.
    const blocks = `const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
      await s.primitives.add("rectangle", {from:[0,0],to:[10,10]}); await s.complete();
      const p = await s.regions.only();
      await core.solid.extrude(p, {start:{type:"offset",offset:3},length1:1});
      await core.solid.extrude(p, {start:{type:"offset",offset:8},length1:2});`;
    await fresh(blocks); await sketch(); await start();
    await choose("extrude-mode", "cut"); await choose("target-scope", "selected");
    await page.locator("#pick-targets").click(); await page.locator("#bodies-tab").click(); await row("Body 2").click();
    await choose("extent1", "throughAll"); await apply();
    await volumes([100]);

    for (const [extent, height] of [["closest", 8], ["touch", 8], ["intersect", 8], ["farthest", 10]]) {
      await fresh(blocks); await sketch(); await start(); await choose("extent1", "toObject");
      await page.locator("#pick-limit1").click(); await page.locator("#bodies-tab").click(); await row("Body 2").click();
      await choose("object-extent1", extent); await apply();
      await volumes([100, 200, height * 100]);
    }

    // From-face start has its own face-only selector; profiles remain selected separately.
    await fresh(blocks); await sketch(); await start(); await ready();
    await choose("extrude-start", "object"); await page.locator("#pick-start").click();
    await page.locator("#home").click(); view = await page.locator("#model-canvas").boundingBox();
    await page.mouse.click(view.x + view.width - 60, view.y + 38);
    await page.mouse.click(view.x + view.width / 2 + 60, view.y + view.height / 2 + 35);
    await page.waitForFunction(() => document.querySelector("#pick-start").textContent.startsWith("1 selected"));
    await page.locator("#length").fill("4"); await choose("extrude-direction", "negative"); await apply();
    const capBounds = await run(`const p = await scene.getProxyFor((await scene.bodies.all()).at(-1)); const z = [...p.positions].filter((_,i)=>i%3===2); return [Math.min(...z), Math.max(...z)];`);
    assert.deepEqual(capBounds, [6, 10]);

    await fresh(`const s = await scene.sketches.create(scene.construction.builtin.planes.xy);
      await s.primitives.add("circle", {center:[0,0],diameter:20}); await s.complete();`);
    await sketch(); await start(); await choose("extrude-type", "twoSides");
    await page.locator("#length").fill("4"); await page.locator("#length2").fill("4");
    await page.locator("#taper1").fill("45 deg"); await page.locator("#taper2").fill("0"); await apply();
    assert.ok(Math.abs((await volume())[0] - Math.PI * (4 * (100 + 140 + 196) / 3 + 400)) < 1e-7);
    console.log("Interactive Extrude: profiles, formulas, length drag, window movement, sides, starts, limits, Boolean targets and tapers passed");
  } finally {
    await context.close();
  }
}
