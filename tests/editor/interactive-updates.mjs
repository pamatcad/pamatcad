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

      const move = (xyz, buttons = 0) => {
        const p = viewport.camera.position.clone().set(...xyz).project(viewport.camera);
        const bounds = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons,
          clientX: bounds.left + (p.x + 1) * bounds.width / 2, clientY: bounds.top + (1 - p.y) * bounds.height / 2 }));
      };
      viewport.setSelection([], "all"); frame();
      let hoverPicks = 0;
      const originalPick = viewport.pick.bind(viewport);
      viewport.pick = (...args) => { hoverPicks++; return originalPick(...args); };
      const beforeHover = renders;
      for (let i = 0; i < 40; i++) move(i === 39 ? [5, 5, 10] : [5, 0, 5]);
      check(hoverPicks === 0, "Pointer bursts must defer hover picking to the next frame");
      frame();
      check(hoverPicks === 1 && renders === beforeHover + 1, "Hover must pick and render only once per frame");
      const hoveredFace = viewport.hover;
      check(JSON.stringify(hoveredFace) === JSON.stringify(before[1]), "Hover must use the latest pointer and identify the same face as a click");
      check(viewport.selection.length === 0 && solid.geometry.groups.some(group => group.materialIndex === 2), "Face hover must highlight without selecting");
      check(solid.material[2].color.equals(solid.material[0].color.clone().lerp(solid.material[1].color, 0.5)), "Face hover must blend halfway toward selection");
      viewport.setSelection([hoveredFace]); frame();
      check(!solid.geometry.groups.some(group => group.materialIndex === 2), "Selection must take priority over hover");
      viewport.setSelection([]); move([5, 0, 10]); frame();
      check(viewport.hover?.kind === "edge" && solid.edgeHover?.visible, "Visible edges must receive a wide hover stroke");
      const edgeHover = solid.edgeHover, hoverGeometry = edgeHover.geometry, hoverMaterial = edgeHover.material;
      const edgePick = viewport.hover;
      check(JSON.stringify(edgePick) === JSON.stringify(pick([5, 0, 10])), "Edge hover and click must agree");
      move([5, 0, 10]); frame();
      viewport.setSelection([edgePick]); frame();
      check(solid.edgeHighlight?.visible && !edgeHover.visible, "Selected edges must retain the full selection stroke");
      viewport.setSelection([]); move([5, 0, 5]); frame(); move([5, 0, 10]); frame();
      check(solid.edgeHover === edgeHover && edgeHover.geometry === hoverGeometry && edgeHover.material === hoverMaterial, "Hover strokes must reuse their GPU resources");
      viewport.setSelection([], "faces"); frame();
      check(viewport.hover?.kind === "face" && !edgeHover.visible, "Face-only tools must not advertise edge selection");
      viewport.setSelection([], "bodies"); frame();
      check(viewport.hover?.kind === "body", "Body-only tools must advertise the body they will select");
      viewport.setSelection([], "none"); frame(); check(!viewport.hover, "Disabled selection must suppress hover");
      viewport.setSelection([], "all"); move([5, 0, 10]); frame();
      viewport.setVisibility(new Set([proxy.body.id])); frame(); check(!viewport.hover, "Hidden bodies must not retain hover");
      viewport.setVisibility(new Set()); frame(); check(viewport.hover?.kind === "edge", "Hover must update under a stationary pointer when visibility changes");
      move([5, 0, 10], 1); frame(); check(!viewport.hover, "Dragging must clear hover");
      move([5, 0, 10]); frame(); canvas.dispatchEvent(new PointerEvent("pointerleave")); frame();
      check(!viewport.hover && !edgeHover.visible, "Leaving the canvas must clear hover");
      viewport.setSelection([], "faces"); viewport.setPreview([proxy]); move([5, 5, 10]); frame();
      check(viewport.preview.children[0].geometry.groups.some(group => group.materialIndex === 2), "Matching preview faces must show hover for selectable source faces");
      viewport.setPreview(); viewport.setSelection([], "all");
      canvas.dispatchEvent(new PointerEvent("pointerleave")); frame();
      viewport.pick = originalPick;

      // Solid topology takes precedence over an overlapping sketch after Apply.
      viewport.setSketches(new Map([[sketch.id, sketchProxy]]));
      for (const mode of ["orthographic", "perspective"]) {
        viewport.restoreView({ mode, position: [25, -35, 35], target: [5, 5, 5], span: 40, zoom: 1 });
        frame();
        viewport.setSelection([], "all");
        for (const point of [[5, 0, 0], [5, 0, 10], [0, 0, 5]])
          check(pick(point)?.kind === "edge", `${mode}: visible solid edges must beat sketch fills`);
        check(pick([2, 10, 0])?.kind === "face", `${mode}: an occluded edge must not be selected`);
        viewport.restoreView({ mode, position: [5, 5, -45], target: [5, 5, 0], span: 40, zoom: 1 });
        frame();
        check(pick([5, 5, 0])?.kind === "face", `${mode}: bottom face must beat coplanar sketch fill`);
        viewport.setSelection([], "profiles");
        check(pick([5, 5, 0])?.kind === "region", "Profile field must still prefer sketch regions");
      }
      const roundSketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
      await roundSketch.primitives.add("circle", { center: [5, 5], diameter: 10 });
      await roundSketch.complete();
      const cylinder = await core.solid.extrude(await roundSketch.regions.only(), { length1: 10 });
      const roundProxy = await scene.getProxyFor(cylinder.newSolids[0]);
      viewport.setBodies(new Map([[roundProxy.body.id, roundProxy]]));
      viewport.setSketches(new Map([[roundSketch.id, await roundSketch.getProxy()]]));
      viewport.setSelection([], "all");
      for (const mode of ["orthographic", "perspective"]) {
        viewport.restoreView({ mode, position: [5, -45, 35], target: [5, 5, 5], span: 40, zoom: 1 }); frame();
        check(pick([5, 0, 0])?.kind === "edge", `${mode}: circular edge must beat sketch fill`);
      }
      viewport.setBodies(new Map([[proxy.body.id, proxy]]));
      viewport.setSelection([], "all");
      viewport.setSketches(new Map());
      viewport.restoreView({ mode: "orthographic", position: [5, -45, 35], target: [5, 5, 5], span: 40, zoom: 1 });
      frame();
      const handle = { id: "length", label: "Length", kind: "length", origin: [0, 0, 0], direction: [0, 0, 1],
        tangent: [1, 0, 0], value: 10, unit: "mm", change() {} };
      const angle = { ...handle, id: "angle", label: "Angle", kind: "angle", unit: "deg", value: 0 };
      viewport.setHandles([handle, angle]);
      frame();
      check(host.querySelector('[data-handle="length"]').textContent === "10 mm", "Length annotation must display its value and unit");
      check(host.querySelector('[data-handle="angle"]').textContent === "0 deg", "Angle annotation must display its value and unit");
      const resources = viewport.handles.group.children.flatMap((group) => group.children.map((mesh) => [mesh.geometry, mesh.material]));
      const resourceCount = resources.flat().length;
      const lengthResources = viewport.handles.group.children[0].children.length * 2;
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
      const angleGroup = viewport.handles.group.children.find((group) => group.userData.handle.id === "angle");
      for (const mesh of angleGroup.children) {
        const bounds = mesh.geometry.boundingSphere, points = mesh.geometry.attributes.position;
        if (!bounds) continue;
        for (let i = 0; i < points.count; i++) check(Math.hypot(points.getX(i) - bounds.center.x,
          points.getY(i) - bounds.center.y, points.getZ(i) - bounds.center.z) <= bounds.radius + 1e-5,
        "Changing an angle must keep its sweep inside the culling bounds");
      }
      const lengthGroup = viewport.handles.group.children.find((group) => group.userData.handle.id === "length");
      check(Math.abs(lengthGroup.position.z - 30) < 1e-10, "Retained length handle must move to its new endpoint");
      const scale = lengthGroup.scale.x;
      viewport.restoreView({ ...viewport.captureView(), zoom: 2 }); frame();
      check(Math.abs(lengthGroup.scale.x * 2 - scale) < 1e-10, "Handle world scale must follow zoom to preserve screen size");
      viewport.setHandles([{ ...handle, value: 6.35, unit: "in" }, { ...angle, value: 90, unit: "rad" }]); frame();
      check(host.querySelector('[data-handle="length"]').textContent === "0.25 in", "Length annotation must convert millimetres to scene units");
      check(host.querySelector('[data-handle="angle"]').textContent === "1.5708 rad", "Angle annotation must convert degrees to scene units");
      viewport.setHandles([angle]); frame();
      check(released === lengthResources, "Removing one handle must release only its own resources");
      viewport.setHandles([]); frame();
      check(released === resourceCount, "Removing all handles must release their retained resources");
      window.requestAnimationFrame = originalFrame;

      const createTool = () => {
        panel.replaceChildren(document.querySelector("#extrude-fields").content.cloneNode(true));
        panel.querySelector("#length").value = "10";
        panel.querySelector("#extrude-mode").value = "newBody";
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
      return { groups, rendersPerBurst, released, resourceCount,
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
  assert.equal(result.released, result.resourceCount);
  assert.deepEqual(result.evaluatedLengths.slice(1, 4), ["15 mm", "23", "21"]);
  assert.ok(Math.abs(result.volume - 2100) < 1e-7);
  console.log("Interactive updates: response-driven previews, latest input, cancellation, one render per frame, persistent handles, and merged face groups passed", result);
  await page.addScriptTag({ path: "tests/editor/rectangle.js" });
  await page.evaluate(async () => {
    const { Viewport } = await import("/src/viewport.ts");
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const until = async (condition) => {
      const deadline = performance.now() + 10000;
      while (!condition()) {
        if (performance.now() > deadline) throw new Error("Editor camera check timed out: " + document.querySelector("#status").textContent);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    let editor;
    const capture = Viewport.prototype.captureView;
    Viewport.prototype.captureView = function (...args) { editor = this; return capture.apply(this, args); };
    try {
      await until(() => !document.querySelector("#new-sketch").disabled);
      document.querySelector("#new-sketch").click();
      await until(() => editor && document.querySelector("#sketch-support"));
    } finally { Viewport.prototype.captureView = capture; }
    let view = JSON.stringify(editor.captureView());
    const restoredView = () => {
      const before = JSON.parse(view), after = editor.captureView();
      const values = v => [...v.position, ...v.target, ...v.up, v.span, v.zoom];
      return before.mode === after.mode && values(before).every((n, i) => Math.abs(n - values(after)[i]) < 1e-9);
    };
    await chooseSketchPlane("XY");
    await until(() => !document.querySelector("#apply").disabled);
    beginRectangleDraft();
    for (const id of ["width", "height"]) {
      const input = document.getElementById(id);
      input.value = "10";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.getElementById("height").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => !document.querySelector("#apply").disabled);
    editor.restoreView({ mode: "orthographic", position: [3, 2, 60], target: [3, 2, 0], span: 60, zoom: 1.7 });
    document.querySelector("#apply").click();
    await until(() => !document.querySelector("#extrude").disabled);
    check(restoredView(), "Finish sketch must restore the pre-sketch camera");
    for (const mode of ["orthographic", "perspective"]) {
      document.querySelector("#sketches-tab").click();
      // The sketch row is exposed through its accessible text rather than a private selector.
      const row = [...document.querySelectorAll("#object-list button")].find(b => b.textContent.trim() === "Sketch 1");
      row.click();
      document.querySelector("#extrude").click();
      await until(() => !document.querySelector("#apply").disabled);
      editor.restoreView({ mode, position: [35, -45, 50], target: [3, 2, 4], span: 45, zoom: 1.3 });
      view = JSON.stringify(editor.captureView());
      document.querySelector("#apply").click();
      await until(() => !document.querySelector("#js").disabled);
      check(JSON.stringify(editor.captureView()) === view, `${mode}: Apply must preserve the camera`);
      check(editor.filter === "all", "Apply must restore general selection including edges");
    }
    view = JSON.stringify(editor.captureView());
    document.querySelector("#new-sketch").click();
    await chooseSketchPlane("YZ");
    await until(() => !document.querySelector("#apply").disabled);
    editor.restoreView({ mode: "orthographic", position: [2, 3, 50], target: [2, 3, 0], span: 30, zoom: 2 });
    document.querySelector("#cancel").click();
    await until(() => !document.querySelector("#new-sketch").disabled);
    check(restoredView(), "Cancel sketch must restore the pre-sketch camera");
  });
  console.log("Pre-sketch camera restored through Finish and Cancel; Apply preserves both projections and restores general edge selection");

}
