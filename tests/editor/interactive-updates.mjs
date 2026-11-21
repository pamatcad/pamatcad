import assert from "node:assert/strict";

export async function testInteractiveUpdates(page, sdk) {
  const result = await page.evaluate(async (sdk) => {
    const { Core } = await import(sdk);
    const { editorTransport } = await import("/src/runtime/transport.ts");
    const { Viewport } = await import("/src/viewport.ts");
    const { ExtrudeTool } = await import("/src/tools/extrude.ts");
    const { lightTheme } = await import("/src/theme.ts");
    const alternateTheme = { ...lightTheme, colors: { ...lightTheme.colors, accent: "#ff8844" } };
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const originalTimeout = window.setTimeout;
    const originalFrame = window.requestAnimationFrame;
    const until = async (condition) => {
      const deadline = performance.now() + 10000;
      while (!condition()) {
        if (performance.now() > deadline) throw new Error("Timed out waiting for a controlled preview response");
        await new Promise((resolve) => originalTimeout(resolve, 0));
      }
    };
    const base = editorTransport(() => {});
    const requests = [], replies = [], snapshots = [], delays = [];
    let hold = false, handles = [], tool, viewport;
    const transport = {
      async request(method, params) {
        const preview = params.preview && ["solid.extrude", "scene.getProxyFor"].includes(method);
        if (preview) requests.push({ method, params });
        const response = await base.request(method, params);
        if (preview && hold) await new Promise((release, reject) => replies.push({ method, release, reject }));
        return response;
      },
      close: () => base.close(),
    };
    const core = new Core(transport);
    const scene = await core.scene.create("Interactive update checks");
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:640px;height:480px";
    document.body.append(host);
    const panel = document.createElement("div");
    document.body.append(panel);
    try {
      const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
      await sketch.primitives.add("rectangle", { from: [0, 0], to: [10, 10] });
      await sketch.primitives.add("rectangle", { from: [20, 0], to: [30, 10] });
      await sketch.complete();
      const regions = await sketch.regions.all();
      const region = regions[0];
      const feature = await core.solid.extrude(region, { length1: 10 });
      const proxy = await scene.getProxyFor(feature.newSolids[0]);
      const sketchProxy = await sketch.getProxy();
      const frames = [], picks = [];
      window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
      const frame = () => frames.splice(0).forEach((callback) => callback(performance.now()));
      viewport = new Viewport(host, (hit) => picks.push(hit.item), () => {}, lightTheme);
      let renders = 0;
      const render = viewport.renderer.render.bind(viewport.renderer);
      viewport.renderer.render = (scene, camera) => {
        if (scene === viewport.scene) renders++;
        render(scene, camera);
      };
      viewport.setBodies(new Map([[proxy.body.id, proxy]]));
      viewport.setSelection([]);
      viewport.home();
      check(renders === 0, "A viewport update should schedule the next frame");
      frame();
      check(renders === 1, "A burst of viewport updates must render the scene once");
      frame();
      check(renders === 1, "An idle viewport must not redraw");
      const solid = viewport.bodies.children[0];
      const triangles = Array.from(proxy.triangles);
      const face = (index) => ({ kind: "face", ref: proxy.faces[index].face, revision: proxy.revision });
      const groups = [];
      for (const selection of [[], [face(1), face(2)], [face(1), face(3)],
        [{ kind: "body", id: proxy.body.id }], proxy.faces.map((_, i) => face(i))]) {
        viewport.setSelection(selection);
        groups.push(solid.geometry.groups.map(({ start, count, materialIndex }) => [start, count, materialIndex]));
      }
      check(JSON.stringify(Array.from(solid.geometry.index.array)) === JSON.stringify(triangles), "Grouping must preserve triangle order");
      viewport.restoreView({ mode: "orthographic", position: [5, -45, 35], target: [5, 5, 5], span: 40, zoom: 1 });
      frame();
      const canvas = viewport.renderer.domElement;
      const pick = (xyz) => {
        const p = viewport.camera.position.clone().set(...xyz).project(viewport.camera);
        const bounds = canvas.getBoundingClientRect();
        const options = { bubbles: true, button: 0, pointerId: 1,
          clientX: bounds.left + (p.x + 1) * bounds.width / 2, clientY: bounds.top + (1 - p.y) * bounds.height / 2 };
        canvas.dispatchEvent(new PointerEvent("pointerdown", options));
        canvas.dispatchEvent(new PointerEvent("pointerup", options));
        return picks.at(-1);
      };
      const before = [[5, 0, 5], [5, 5, 10]].map(pick);
      check(before.every((item) => item?.kind === "face"), "Both test points must pick solid faces");
      viewport.setSelection([face(1), face(3)]);
      frame();
      check(JSON.stringify([[5, 0, 5], [5, 5, 10]].map(pick)) === JSON.stringify(before), "Merged groups must preserve canvas face picks");

      const handle = { id: "length", label: "Length", kind: "length", origin: [0, 0, 0], direction: [0, 0, 1],
        tangent: [1, 0, 0], value: 10, unit: "mm", change() {} };
      const angle = { ...handle, id: "angle", label: "Angle", kind: "angle", unit: "deg", value: 0 };
      viewport.setHandles([handle, angle]);
      frame();
      const resources = viewport.handles.group.children.flatMap((group) => group.children.map((mesh) => [mesh.geometry, mesh.material]));
      let released = 0;
      resources.flat().forEach((resource) => resource.addEventListener("dispose", () => released++));
      const initialRenders = renders;
      for (let i = 1; i <= 20; i++) {
        viewport.setHandles([{ ...handle, value: 10 + i }, { ...angle, value: i * 5 }]);
        viewport.setTheme(i % 2 ? alternateTheme : lightTheme);
        viewport.setSelection([]);
        frame();
      }
      check(renders - initialRenders === 20, "Each update burst must render exactly once");
      const rendersPerBurst = (renders - initialRenders) / 20;
      const retained = viewport.handles.group.children.flatMap((group) => group.children.map((mesh) => [mesh.geometry, mesh.material]));
      check(retained.every((pair, i) => pair.every((resource, j) => resource === resources[i][j])), "Handle updates must retain geometry and materials");
      check(released === 0, "Updating handle transforms must not dispose their resources");
      const lengthGroup = viewport.handles.group.children.find((group) => group.userData.handle.id === "length");
      check(Math.abs(lengthGroup.position.z - 30) < 1e-10, "Retained length handle must move to its new endpoint");
      const scale = lengthGroup.scale.x;
      viewport.restoreView({ ...viewport.captureView(), zoom: 2 }); frame();
      check(Math.abs(lengthGroup.scale.x * 2 - scale) < 1e-10, "Handle world scale must follow zoom to preserve screen size");
      viewport.setHandles([angle]); frame();
      check(released === 4, "Removing one handle must release only its two meshes and materials");
      viewport.setHandles([]); frame();
      check(released === 8, "Removing all handles must release their retained resources");
      window.requestAnimationFrame = originalFrame;

      const createTool = () => {
        panel.replaceChildren(document.querySelector("#extrude-fields").content.cloneNode(true));
        panel.querySelector("#length").value = "10";
        return new ExtrudeTool(panel, scene, transport, new Map([[sketch.id, sketchProxy]]), new Map([[proxy.body.id, proxy]]), {
          changed() {}, status() {}, handles(items = []) { handles = items; },
          preview(bodies = []) {
            if (bodies.length) snapshots.push(Math.max(...Array.from(bodies[0].positions).filter((_, i) => i % 3 === 2)));
          },
        });
      };
      const release = async (method) => {
        await until(() => replies.length > 0);
        const reply = replies.shift();
        check(reply.method === method, `Expected ${method}, got ${reply.method}`);
        reply.release();
      };
      const edit = (text) => {
        const input = panel.querySelector("#length");
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      window.setTimeout = (callback, delay, ...args) => {
        delays.push(delay ?? 0);
        return originalTimeout(callback, delay, ...args);
      };
      hold = true;
      tool = createTool();
      await tool.seed([{ kind: "region", ref: region }]);
      await until(() => replies.length > 0);
      const initialLength = requests[0].params.parameters.length1;
      for (const value of [11, 12, 13]) handles.find((handle) => handle.id === "length").change(value);
      check(requests.length === 1 && !tool.ready, "Rapid input must retain one in-flight preview and disable Apply");
      await release("solid.extrude");
      await until(() => replies.length > 0);
      for (const value of [14, 15]) handles.find((handle) => handle.id === "length").change(value);
      check(requests.filter((request) => request.method === "solid.extrude").length === 1, "The next preview must wait for mesh retrieval");
      await release("scene.getProxyFor");
      await until(() => replies.length > 0);
      check(snapshots.length === 1 && snapshots[0] === Number(initialLength), "A completed intermediate drag preview must be displayed");
      check(requests.at(-1).params.parameters.length1 === "15 mm", "Only the latest queued handle value may be evaluated");
      check(!tool.ready, "An intermediate preview must not enable Apply");
      let rejected = false;
      try { await tool.apply(); } catch { rejected = true; }
      check(rejected, "Apply must reject an intermediate preview");
      edit("23");
      await release("solid.extrude");
      await until(() => replies.length > 0);
      check(snapshots.length === 1 && requests.at(-1).params.parameters.length1 === "23", "Typed edits must reject an obsolete drag result and run immediately");
      await release("solid.extrude"); await release("scene.getProxyFor");
      await until(() => tool.ready);
      check(snapshots.at(-1) === 23, "The final preview must match the latest typed input");
      edit("2 deg");
      await until(() => !tool.pending && panel.querySelector("#length").getAttribute("aria-invalid") === "true");
      check(!tool.ready, "Invalid formulas must disable Apply");
      edit("21");
      await release("solid.extrude"); await release("scene.getProxyFor");
      await until(() => tool.ready);
      const applied = await tool.apply();
      const volume = (await (await scene.bodies.get(applied.newSolids[0].id)).properties()).volume.value;
      check(Math.abs(volume - 2100) < 1e-7, `Apply must commit the latest recovered input: ${volume}`);
      tool.close(false);
      tool = createTool();
      await tool.seed(regions.map((ref) => ({ kind: "region", ref })));
      await release("solid.extrude");
      await until(() => replies.length === 2);
      handles.find((handle) => handle.id === "length").change(12);
      const requested = requests.length;
      replies.shift().reject(new Error("Controlled mesh failure"));
      await new Promise((resolve) => originalTimeout(resolve, 0));
      check(tool.pending && requests.length === requested, "A failed mesh must not start another preview while other meshes are pending");
      await release("scene.getProxyFor");
      await release("solid.extrude");
      await release("scene.getProxyFor"); await release("scene.getProxyFor");
      await until(() => tool.ready);
      check(snapshots.at(-1) === 12, "A multi-body mesh failure must recover with the latest queued input");
      tool.close();
      tool = createTool();
      await tool.seed([{ kind: "region", ref: region }]);
      await release("solid.extrude");
      await until(() => replies.length > 0);
      const displayed = snapshots.length;
      tool.close();
      await release("scene.getProxyFor");
      await until(() => !tool.pending);
      check(snapshots.length === displayed && handles.length === 0, "A cancelled mesh response must not restore previews or handles");
      check(delays.length === 0, `Preview scheduling must not use timer delays: ${delays}`);
      return { groups, rendersPerBurst, released,
        evaluatedLengths: requests.filter((request) => request.method === "solid.extrude").map((request) => request.params.parameters.length1),
        snapshots, volume };
    } finally {
      window.setTimeout = originalTimeout;
      window.requestAnimationFrame = originalFrame;
      hold = false;
      replies.splice(0).forEach((reply) => reply.release());
      tool?.close();
      if (tool) await until(() => !tool.pending);
      if (viewport) { viewport.setHandles([]); viewport.setBodies(new Map()); }
      await new Promise((resolve) => originalFrame(resolve));
      viewport?.renderer.dispose();
      host.remove(); panel.remove();
      await scene.close(); core.close();
    }
  }, sdk);
  assert.deepEqual(result.groups.map((groups) => groups.length), [1, 3, 5, 1, 1]);
  for (const groups of result.groups) assert.equal(groups.reduce((sum, group) => sum + group[1], 0), 36);
  assert.equal(result.rendersPerBurst, 1);
  assert.equal(result.released, 8);
  assert.deepEqual(result.evaluatedLengths.slice(1, 4), ["15 mm", "23", "21"]);
  assert.ok(Math.abs(result.volume - 2100) < 1e-7);
  console.log("Interactive updates: response-driven previews, latest input, cancellation, one render per frame, persistent handles, and merged face groups passed", result);
}
