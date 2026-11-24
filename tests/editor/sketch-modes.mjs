import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function testSketchModes(page) {
  await page.getByText("File", { exact: true }).click();
  await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts"), start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) { window.modeCheck = { tool: this }; return start.apply(this, args); };
    try { document.querySelector("#new-sketch").click(); } finally { SketchTool.prototype.start = start; }
  });
  await page.evaluate(() => chooseSketchPlane("XY"));
  const idle = () => page.waitForFunction(() => {
    const t = window.modeCheck.tool;
    return t.state && !t.pending && !t.updateRunning && !t.previewQueued && !t.creating;
  });
  const screen = xy => page.evaluate(xy => {
    const { viewport: v, state: { frame } } = window.modeCheck.tool;
    v.camera.updateMatrixWorld();
    const p = v.camera.position.clone().fromArray(frame.origin)
      .addScaledVector(v.camera.position.clone().fromArray(frame.u), xy[0])
      .addScaledVector(v.camera.position.clone().fromArray(frame.v), xy[1]).project(v.camera);
    const r = document.querySelector("#model-canvas").getBoundingClientRect();
    return [r.x + (p.x + 1) * r.width / 2, r.y + (1 - p.y) * r.height / 2];
  }, xy);
  const click = async xy => { await page.mouse.click(...await screen(xy)); await idle(); };
  const selected = () => page.evaluate(() => [...window.modeCheck.tool.selected]);
  const select = refs => page.evaluate(refs => {
    const t = window.modeCheck.tool; t.selected.clear(); refs.forEach(r => t.selected.add(r.id)); t.selectionChanged();
  }, refs);
  const pick = async ref => {
    await page.evaluate(ref => window.modeCheck.tool.click({ picks: [{ kind: "geometry", id: ref.id }], additive: false, client: [0, 0] }), ref);
    await idle();
  };
  const button = kind => page.locator(`[data-constraint="${kind}"]`);
  const cursor = () => page.evaluate(() => {
    const img = document.querySelector(".sketch-cursor-symbol"), canvas = document.querySelector("#model-canvas");
    return { hidden: img.hidden, src: img.getAttribute("src"), cursor: canvas.style.cursor,
      width: img.getBoundingClientRect().width, loaded: img.complete && img.naturalWidth === 16 };
  });
  try {
    await idle();
    await page.getByRole("button", { name: "Snap to geometry", exact: true }).click();
    await page.mouse.move(...await screen([-20, 20]));
    assert.equal((await cursor()).cursor, "default"); assert.equal((await cursor()).hidden, true);
    for (const tool of ["point", "line", "rectangle", "circle", "arc", "ellipse", "slot", "spline", "text"]) {
      await page.locator(`[data-tool="${tool}"]`).click();
      assert.equal(await page.locator("#sketch-action").isVisible(), false, tool + " has no submission button");
      await page.keyboard.press("Escape");
    }

    // A new rectangle starts with fresh inputs but retains its variant and geometry mode.
    await page.getByRole("button", { name: "Construction geometry", exact: true }).click();
    await page.locator('[data-tool="rectangle"]').click();
    await page.getByRole("button", { name: "Centered", exact: true }).click();
    await click([-20, 15]); await page.mouse.move(...await screen([-16, 18])); await idle();
    await page.locator("#width").fill("8 mm"); await idle(); await page.locator("#width").press("Enter"); await idle();
    assert.deepEqual(await page.evaluate(() => {
      const t = window.modeCheck.tool; return [t.tool, t.variant, t.points.length, t.dirty.size, t.constructionMode];
    }), ["rectangle", 2, 0, 0, true]);
    await click([-5, 15]); await page.mouse.move(...await screen([-10, 9])); await idle();
    assert.equal(await page.locator("#apply").isDisabled(), true);
    await page.locator("#model-canvas").focus(); await page.keyboard.press("Enter"); await idle();
    assert.equal(await page.locator("#apply").isDisabled(), false);
    const rectangles = await page.evaluate(() => window.modeCheck.tool.state);
    assert.equal(rectangles.entities.filter(e => e.geometry.type === "line").length, 12);
    assert.ok(rectangles.entities.filter(e => e.geometry.type === "line").every(e => e.construction));
    assert.equal(rectangles.dimensions.length, 1, "Typed dimensions do not leak into the next shape");
    await page.locator('[data-tool="rectangle"]').click();
    assert.equal(await page.evaluate(() => window.modeCheck.tool.tool), "select");
    await page.getByRole("button", { name: "Normal geometry", exact: true }).click();

    const refs = await page.evaluate(async () => {
      const t = window.modeCheck.tool, s = t.sketch;
      const a = await s.primitives.add("line", { from: [-25, -12], to: [-15, -12] });
      const b = await s.primitives.add("line", { from: [-25, -20], to: [-15, -20] });
      const c = await s.primitives.add("line", { from: [0, -12], to: [10, -12] });
      const d = await s.primitives.add("line", { from: [0, -20], to: [10, -20] });
      const circle = await s.primitives.add("circle", { center: [20, 10], diameter: 6 });
      const p = await s.primitives.add("point", { position: [18, -5] });
      const q = await s.primitives.add("point", { position: [18, -8] });
      await t.reload(); return { a, b, c, d, circle, p, q };
    });
    // Contextual activation permits partial operands, and complete preselection applies at once.
    await click([20, 13]);
    assert.equal(await button("perpendicular").isDisabled(), true);
    assert.equal(await button("concentric").isDisabled(), false);
    assert.equal(await button("fix").isDisabled(), false);
    await select([refs.a.curves[0]]); await button("parallel").click();
    assert.deepEqual(await selected(), [refs.a.curves[0].id]);
    await pick(refs.circle.curves[0]); assert.deepEqual(await selected(), [refs.a.curves[0].id]);
    await pick(refs.a.curves[0]); assert.deepEqual(await selected(), []);
    await pick(refs.a.curves[0]); await click([-30, -25]); assert.deepEqual(await selected(), []);
    await click([-20, -12]); await click([-20, -20]);
    assert.deepEqual(await selected(), []); assert.equal(await button("parallel").getAttribute("aria-pressed"), "true");
    await click([5, -12]); await click([5, -20]);
    assert.equal(await page.evaluate(() => window.modeCheck.tool.state.constraints.filter(c => c.kind === "parallel").length), 2);
    await page.keyboard.press("Escape");
    await select([refs.a.curves[0]]); await button("horizontal").click(); await idle();
    assert.deepEqual(await selected(), []);
    assert.ok(await page.evaluate(id => window.modeCheck.tool.state.constraints.some(c => c.kind === "horizontal" && c.parameters.curves[0].id === id), refs.a.curves[0].id));

    // Fix accepts successive clicks while an earlier application is awaiting its response.
    await page.keyboard.press("Escape"); await button("fix").click();
    await page.evaluate(() => {
      const c = window.modeCheck, constraints = c.tool.sketch.constraints, original = constraints.add.bind(constraints);
      c.restore = () => { constraints.add = original; };
      let first = true;
      constraints.add = async (...args) => {
        const result = await original(...args);
        if (first) { first = false; await new Promise(resolve => { c.release = resolve; }); }
        return result;
      };
    });
    await page.mouse.click(...await screen([18, -5]));
    await page.waitForFunction(() => !!window.modeCheck.release);
    await page.mouse.click(...await screen([18, -8]));
    await page.evaluate(() => window.modeCheck.release()); await idle();
    await page.evaluate(() => window.modeCheck.restore());
    assert.equal(await page.evaluate(() => window.modeCheck.tool.state.constraints.filter(c => c.kind === "fix").length), 2);
    const fixed = await page.evaluate(() => window.modeCheck.tool.state);
    await click([18, -5]); assert.deepEqual(await page.evaluate(() => window.modeCheck.tool.state), fixed, "Repeated Fix is idempotent");
    await button("fix").click(); assert.equal(await page.evaluate(() => window.modeCheck.tool.constraint), undefined);

    // Core rejection keeps mode and operands; the next valid application can recover.
    await button("coincident").click(); await pick(refs.p.points[0]); await pick(refs.q.points[0]);
    assert.match(await page.locator("#sketch-error").innerText(), /constraint|solve|fixed|conflict/i);
    assert.deepEqual(new Set(await selected()), new Set([refs.p.points[0].id, refs.q.points[0].id]));
    assert.equal(await button("coincident").getAttribute("aria-pressed"), "true");
    await click([-30, -25]); await pick(refs.a.points[0]); await pick(refs.c.points[0]);
    assert.deepEqual(await selected(), []); assert.equal(await page.locator("#sketch-error").innerText(), "");

    // Mixed operands are picked in either order; symmetry waits for all three references.
    await page.keyboard.press("Escape"); await button("pointOnCurve").click();
    await pick(refs.circle.curves[0]); await pick(refs.b.points[0]);
    assert.deepEqual(await selected(), []);
    await page.keyboard.press("Escape");
    const symmetry = await page.evaluate(async () => {
      const t = window.modeCheck.tool, s = t.sketch;
      const axis = await s.primitives.add("line", { from: [0, 30], to: [0, 40] });
      const a = await s.primitives.add("point", { position: [-5, 35] });
      const b = await s.primitives.add("point", { position: [5, 35] });
      await t.reload(); return { axis, a, b };
    });
    await button("symmetric").click(); await pick(symmetry.axis.curves[0]); await pick(symmetry.a.points[0]);
    assert.equal((await selected()).length, 2);
    await pick(symmetry.b.points[0]); assert.deepEqual(await selected(), []);
    assert.ok(await page.evaluate(() => window.modeCheck.tool.state.constraints.some(c => c.kind === "symmetric")));
    await page.keyboard.press("Escape");
    const freePoint = await page.evaluate(async () => {
      const t = window.modeCheck.tool, p = await t.sketch.primitives.add("point", { position: [-30, 0] });
      await t.reload(); return p.points[0];
    });
    await page.mouse.move(...await screen([-30, 0])); await page.mouse.down();
    await page.mouse.move(...await screen([-28, 2]), { steps: 5 }); await page.mouse.up(); await idle();
    const movedPoint = await page.evaluate(ref => window.modeCheck.tool.state.entities.find(e => e.reference.id === ref.id).geometry.position, freePoint);
    assert.ok(Math.hypot(movedPoint[0] + 28, movedPoint[1] - 2) < 1e-5, "Leaving constraint mode restores geometry dragging");

    // Editing applications retain their mode and clear the consumed operands.
    const operations = await page.evaluate(async () => {
      const t = window.modeCheck.tool, s = t.sketch, results = [];
      const circle = await s.primitives.add("circle", { center: [70, 0], diameter: 10 });
      const apply = async (mode, refs, values) => {
        await t.reload(); t.choose(mode); t.selected.clear(); refs.forEach(r => t.selected.add(r.id));
        Object.entries(values).forEach(([id, value]) => t.setNumericField(id, value));
        await t.run(() => t.action());
        if (t.get("sketch-error").textContent) throw new Error(t.get("sketch-error").textContent);
        results.push([t.tool, t.selected.size]);
      };
      await apply("offset", circle.curves, { "sketch-offset": 2 });
      await apply("move", circle.curves, { "sketch-move-x": 2, "sketch-move-y": 0, "sketch-angle": 15 });
      results.push(["angle", t.input("sketch-angle").value]);
      await apply("scale", circle.curves, { "sketch-scale": 2 });
      const a = await s.primitives.add("line", { from: [100, 0], to: [110, 0] });
      const b = await s.primitives.add("line", { from: [110, 0], to: [110, 10] });
      await apply("rounding", [...a.curves, ...b.curves], { "sketch-radius": 2 });
      const c = await s.primitives.add("line", { from: [120, 0], to: [130, 10] });
      const d = await s.primitives.add("line", { from: [120, 10], to: [130, 0] });
      await apply("split", [...c.curves, ...d.curves], {});
      return results;
    });
    assert.deepEqual(operations, [["offset", 0], ["move", 0], ["angle", "15 deg"], ["scale", 0], ["rounding", 0], ["split", 0]]);

    // All commands have simple outline cursor assets; variants reuse the same symbol.
    const files = await readdir("apps/editor/src/icons/cursors");
    for (const file of files) {
      const svg = await readFile("apps/editor/src/icons/cursors/" + file, "utf8");
      assert.match(svg, /viewBox="0 0 16 16"/); assert.match(svg, /fill="none"/);
      assert.match(svg, /class="cursor-line".*stroke="#000" stroke-width="1"/);
      assert.doesNotMatch(svg, /<circle|<text|fill="(?!none)/);
    }
    for (const scale of [1, 2]) {
      const sample = await page.context().browser().newPage({ viewport: { width: 640, height: 160 }, deviceScaleFactor: scale });
      try {
        const sources = files.map(file => new URL("/src/icons/cursors/" + file, page.url()).href);
        await sample.setContent(`<style>body{margin:0}section{display:flex;gap:4px;padding:16px}img{width:16px;height:16px}</style>` +
          ["#fff", "#222"].map(color => `<section style="background:${color}">${sources.map(src => `<img src="${src}">`).join("")}</section>`).join(""));
        await sample.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth === 16));
        await sample.screenshot({ path: `/private/tmp/pamatcad-cursor-symbols-${scale}x.png` });
      } finally { await sample.close(); }
    }
    await page.locator('[data-tool="rectangle"]').click();
    await page.mouse.move(...await screen([-30, 20]));
    const drawing = await cursor(); assert.equal(drawing.hidden, false); assert.equal(drawing.width, 16); assert.ok(drawing.loaded);
    assert.match(drawing.cursor, /8 8, crosshair$/);
    await page.getByRole("button", { name: "Three points", exact: true }).click();
    await page.mouse.move(...await screen([-30, 20])); assert.equal((await cursor()).src, drawing.src);
    await page.screenshot({ path: "/private/tmp/pamatcad-sketch-command-cursor.png" });
    await page.evaluate(() => {
      const c = window.modeCheck, transport = c.tool.sketch.transport, request = transport.request;
      c.calls = []; c.restoreTransport = () => { transport.request = request; };
      transport.request = function (...args) { c.calls.push(args[0]); return request.apply(this, args); };
    });
    await page.mouse.move(...await screen([-28, 18]), { steps: 12 }); await idle();
    assert.deepEqual(await page.evaluate(() => window.modeCheck.calls), [], "Cursor movement without a draft never calls the core");
    await page.mouse.down({ button: "middle" }); assert.equal((await cursor()).hidden, true);
    await page.mouse.up({ button: "middle" }); await page.mouse.move(...await screen([-29, 18])); assert.equal((await cursor()).hidden, false);
    const bounds = await page.locator("#model-canvas").boundingBox();
    await page.mouse.move(bounds.x + bounds.width - 60, bounds.y + 60); assert.equal((await cursor()).hidden, true);
    await page.locator("#tool-panel").hover(); assert.equal((await cursor()).hidden, true);
    await page.keyboard.press("Escape"); await button("fix").click();
    await page.mouse.move(...await screen([-30, 20]));
    assert.equal((await cursor()).hidden, false); assert.equal((await cursor()).cursor, "default");
    assert.match(decodeURIComponent((await cursor()).src), /<title>Fix<\/title>/);
    await page.locator('[data-tool="move"]').click(); await page.mouse.move(...await screen([-30, 20]));
    assert.equal((await cursor()).cursor, "default"); assert.match(decodeURIComponent((await cursor()).src), /<title>Move<\/title>/);
    await page.locator("#sketch-move-x").hover(); assert.equal((await cursor()).hidden, true);
    await page.evaluate(() => window.modeCheck.restoreTransport());

    const id = await page.locator('#document-tabs [aria-selected="true"]').getAttribute("data-document");
    await page.keyboard.press("Escape"); await button("parallel").click(); await pick(refs.d.curves[0]);
    await page.getByText("File", { exact: true }).click(); await page.locator("#menu-new").click();
    await page.waitForFunction(id => document.querySelector('#document-tabs [aria-selected="true"]').dataset.document !== id, id);
    await page.mouse.move(...await screen([-30, 20])); assert.equal((await cursor()).hidden, true);
    await page.locator(`#document-tabs [data-document="${id}"]`).click(); await idle();
    await page.mouse.move(...await screen([-30, 20]));
    assert.match(decodeURIComponent((await cursor()).src), /<title>Parallel<\/title>/); assert.equal((await cursor()).hidden, false);
    assert.deepEqual(await selected(), [refs.d.curves[0].id]);
    await page.keyboard.press("Escape");
    assert.equal((await cursor()).hidden, true); assert.equal((await cursor()).cursor, "default");
    await page.locator('[data-tool="spline"]').click();
    await click([0, 22]); await click([5, 25]); await click([10, 22]);
    await page.mouse.move(...await screen([15, 26])); await idle();
    assert.equal(await page.locator("#apply").isDisabled(), true);
    await page.locator("#model-canvas").focus(); await page.keyboard.press("Enter"); await idle();
    const spline = await page.evaluate(() => window.modeCheck.tool.state.entities.find(e => e.geometry.type === "spline").geometry);
    assert.equal(spline.points.length, 3, "Enter finishes the confirmed spline points without its hover point");
    assert.equal(await page.evaluate(() => window.modeCheck.tool.tool), "spline");
    assert.equal(await page.locator("#apply").isDisabled(), false);
    await page.locator("#cancel").click();
    await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
    const projected = await page.evaluate(async sdk => {
      const { Core } = await import(sdk), { editorTransport } = await import("/src/runtime/transport.ts");
      const { SketchTool } = await import("/src/tools/sketch.ts");
      const core = new Core(editorTransport(() => {})), scene = await core.scene.create("Repeated projection");
      const panel = document.createElement("div"); document.body.append(panel);
      let tool;
      try {
        const source = await scene.sketches.create(scene.construction.builtin.planes.xy);
        await source.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
        await source.primitives.add("rectangle", { from: [20, 0], to: [30, 10] });
        await source.complete();
        const profiles = await source.regions.all(), feature = await core.solid.extrude(profiles, { length1: 2 });
        tool = new SketchTool(panel, scene, window.modeCheck.tool.viewport, { changed() {}, proxy() {}, visibility() {}, status() {} });
        await tool.start(undefined, scene.construction.builtin.planes.xy); tool.choose("project");
        const first = await feature.faces.endCap1({ profile: profiles[0] }).only();
        tool.click({ item: { kind: "face", ref: first }, picks: [], client: [0, 0] }); await tool.queue;
        const second = await feature.faces.endCap1({ profile: profiles[1] }).only();
        tool.click({ item: { kind: "face", ref: second }, picks: [], client: [0, 0] }); await tool.queue;
        return [tool.tool, tool.state.projections.length, tool.state.entities.filter(e => e.projected && e.geometry.type === "line").length];
      } finally { if (tool) { await tool.cancel(); tool.close(); } panel.remove(); await scene.close(); core.close(); }
    }, "/@fs" + resolve("sdk/javascript/dist/index.js"));
    assert.deepEqual(projected, ["project", 2, 8]);
    console.log("Sketch modes: repeated drawing, contextual constraints, fresh pairs, rapid Fix, duplicates/failures, edit persistence and cursor/navigation/tab lifecycle passed");
  } finally {
    await page.evaluate(() => { const c = window.modeCheck; c.release?.(); c.restore?.(); c.restoreTransport?.(); delete window.modeCheck; });
  }
}
