import assert from "node:assert/strict";

export async function testSketchUpdates(page) {
  await page.getByText("File", { exact: true }).click();
  await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled && !document.querySelector("#features").children.length);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts");
    const start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) {
      window.sketchUpdates = { tool: this, requests: [], replies: [], snapshots: [], delays: [], hold: true };
      return start.apply(this, args);
    };
    try { document.querySelector("#new-sketch").click(); }
    finally { SketchTool.prototype.start = start; }
  });
  const idle = () => page.waitForFunction(() => {
    const t = window.sketchUpdates.tool;
    return !t.pending && !t.updateRunning && !t.previewQueued && !t.creating;
  });
  const screen = xy => page.evaluate(xy => {
    const { viewport, state } = window.sketchUpdates.tool, frame = state.frame;
    viewport.camera.updateMatrixWorld();
    const p = viewport.camera.position.clone().fromArray(frame.origin)
      .addScaledVector(viewport.camera.position.clone().fromArray(frame.u), xy[0])
      .addScaledVector(viewport.camera.position.clone().fromArray(frame.v), xy[1]).project(viewport.camera);
    const r = document.querySelector("#model-canvas").getBoundingClientRect();
    return [r.x + (p.x + 1) * r.width / 2, r.y + (1 - p.y) * r.height / 2];
  }, xy);
  const state = () => page.evaluate(() => {
    const c = window.sketchUpdates, t = c.tool;
    return { requests: c.requests, snapshots: c.snapshots, valid: t.draftValid, ready: t.ready,
      disabled: t.get("sketch-action").disabled, tool: t.tool, state: t.state, error: t.get("sketch-error").textContent };
  });
  const waitReply = method => page.waitForFunction(method => window.sketchUpdates.replies.some(r => r.method === method), method);
  const release = async (method, reject = false) => {
    await waitReply(method);
    await page.evaluate(({ method, reject }) => {
      const replies = window.sketchUpdates.replies;
      const [reply] = replies.splice(replies.findIndex(r => r.method === method), 1);
      if (reject) reply.reject(new Error("Controlled preview read failure")); else reply.resolve();
    }, { method, reject });
  };
  const readPreview = async () => {
    await release("sketch.primitives.add");
    await release("sketch.state");
    await release("sketch.getProxy");
  };
  try {
    await page.locator("#sketch-planes").getByRole("button", { name: "XY", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("#apply").disabled);
    await page.evaluate(() => {
      const c = window.sketchUpdates, t = c.tool;
      c.transport = t.sketch.transport;
      c.request = c.transport.request;
      c.transport.request = async function (method, params) {
        const controlled = params.preview && ["sketch.primitives.add", "sketch.state", "sketch.getProxy"].includes(method);
        if (controlled) c.requests.push({ method, params: structuredClone(params) });
        const result = await c.request.call(this, method, params);
        if (controlled && c.hold) await new Promise((resolve, reject) => c.replies.push({ method, resolve, reject }));
        return result;
      };
      c.display = t.display;
      t.display = function (...args) {
        if (args[0] && args[0] !== this.state) c.snapshots.push(structuredClone(args[0]));
        return c.display.apply(this, args);
      };
      c.timeout = window.setTimeout;
      window.setTimeout = function (callback, delay, ...args) {
        if (delay > 0 && new Error().stack.includes("/src/tools/sketch.ts")) c.delays.push(delay);
        return c.timeout.call(window, callback, delay, ...args);
      };
    });

    // Continuous pointer movement must display intermediate results without waiting for a pause.
    await page.locator('#sketch-ribbon [data-tool="rectangle"]').click();
    await page.mouse.click(...await screen([-20, 20]));
    await page.mouse.move(...await screen([-10, 10]));
    await waitReply("sketch.primitives.add");
    await page.mouse.move(...await screen([0, -5]), { steps: 12 });
    assert.equal((await state()).requests.length, 1);
    await release("sketch.primitives.add");
    await waitReply("sketch.getProxy");
    await page.mouse.move(...await screen([2, -8]), { steps: 8 });
    await release("sketch.state");
    assert.equal((await state()).requests.filter(r => r.method === "sketch.primitives.add").length, 1, "Proxy retrieval is part of the in-flight update");
    await release("sketch.getProxy");
    await waitReply("sketch.primitives.add");
    let current = await state();
    assert.equal(current.snapshots.length, 1, "Completed intermediate preview is displayed during movement");
    assert.equal(current.valid, false);
    assert.equal(current.disabled, true);
    const additions = current.requests.filter(r => r.method === "sketch.primitives.add");
    assert.equal(additions.length, 2, "Only the latest waiting pointer position is evaluated");
    const latest = additions[1].params.primitive.parameters.to;
    assert.ok(Math.hypot(latest[0] - 2, latest[1] + 8) < 1e-5);

    // Clicking before the pending response returns commits the clicked endpoint, not the displayed preview.
    await page.mouse.click(...await screen([5, -10]));
    await release("sketch.primitives.add");
    await idle();
    current = await state();
    assert.equal(current.tool, "select");
    assert.equal(current.requests.filter(r => r.method === "sketch.primitives.add").length, 2);
    assert.ok(current.state.entities.some(e => e.geometry.type === "point" && Math.hypot(e.geometry.position[0] - 5, e.geometry.position[1] + 10) < 1e-5));
    const committed = current.state;

    // Cancellation and a different drawing tool invalidate an old response, including its queued follow-up.
    await page.locator('#sketch-ribbon [data-tool="circle"]').click();
    await page.mouse.click(...await screen([-15, 5]));
    await page.mouse.move(...await screen([-10, 5]));
    await release("sketch.primitives.add");
    await waitReply("sketch.getProxy");
    await page.mouse.move(...await screen([-8, 5]));
    await page.keyboard.press("Escape");
    const shown = (await state()).snapshots.length;
    await page.evaluate(() => window.sketchUpdates.tool.choose("line"));
    await release("sketch.state"); await release("sketch.getProxy"); await idle();
    current = await state();
    assert.equal(current.snapshots.length, shown);
    assert.deepEqual(current.state, committed);
    assert.equal(current.tool, "line");

    // Suspending and resuming the same draft rejects old responses and regenerates its latest preview.
    await page.mouse.click(...await screen([-10, -15]));
    await page.mouse.move(...await screen([5, -20]));
    await release("sketch.primitives.add");
    await waitReply("sketch.getProxy");
    const beforeSuspend = (await state()).snapshots.length;
    await page.evaluate(() => { const t = window.sketchUpdates.tool; t.suspend(); t.resume(); });
    await release("sketch.state"); await release("sketch.getProxy");
    await waitReply("sketch.primitives.add");
    assert.equal((await state()).snapshots.length, beforeSuspend);
    await readPreview(); await idle();
    assert.equal((await state()).snapshots.length, beforeSuspend + 1);

    // A failed read must not let the next update replace the cache while its companion is pending.
    await page.mouse.move(...await screen([8, -22]));
    await release("sketch.primitives.add");
    await waitReply("sketch.getProxy");
    await page.mouse.move(...await screen([10, -23]));
    const beforeFailure = (await state()).requests.length;
    await release("sketch.state", true);
    await page.evaluate(() => new Promise(resolve => window.sketchUpdates.timeout.call(window, resolve, 0)));
    assert.equal((await state()).requests.length, beforeFailure);
    await release("sketch.getProxy"); await readPreview(); await idle();
    assert.equal((await state()).valid, true);

    // Typed formulas use the same update loop and recover after invalid input.
    await page.locator("#width").fill("2 deg");
    await idle();
    assert.equal((await state()).valid, false);
    assert.notEqual((await state()).error, "");
    await page.locator("#width").fill("30 / 2");
    await readPreview(); await idle();
    assert.equal((await state()).valid, true);
    assert.equal((await state()).error, "");
    assert.deepEqual(await page.evaluate(() => window.sketchUpdates.delays), [], "Sketch updates must not use a timer delay");
    await page.screenshot({ path: "/private/tmp/pamatcad-drawing-updates.png" });
    await page.keyboard.press("Escape");
    await page.locator("#apply").click();
    await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled && document.querySelector("#features").children.length === 1);
    console.log("Sketch previews: immediate updates, intermediate display, latest input, exact final click, cancellation, resume, read failure and formula recovery passed");
  } finally {
    await page.evaluate(() => {
      const c = window.sketchUpdates;
      if (c.transport) c.transport.request = c.request;
      if (c.display) c.tool.display = c.display;
      if (c.timeout) window.setTimeout = c.timeout;
      c.hold = false; c.replies.splice(0).forEach(r => r.resolve());
      delete window.sketchUpdates;
    });
  }
}
