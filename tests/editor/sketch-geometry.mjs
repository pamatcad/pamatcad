import assert from "node:assert/strict";

export async function testSketchConstructors(page,sdk) {
  const results=await page.evaluate(async sdk=>{
    const {Core}=await import(sdk);
    const {editorTransport}=await import("/src/runtime/transport.ts");
    const {drawing}=await import("/src/tools/sketch-geometry.ts");
    const core=new Core(editorTransport(()=>{})),scene=await core.scene.create("Sketch constructors");
    const sketch=await scene.sketches.create(scene.construction.builtin.planes.xy);
    const fields={width:20,height:10,radius:10,angle:90,size:10,text:"B",weight:400,horizontal:"left",vertical:"baseline",closed:false};
    try {
      const base=await sketch.state();
      const make=(tool,variant,points,f=fields,selected=[],state=base)=>drawing(tool,variant,points,f,false,selected,state);
      const circle2=make("circle",1,[[0,0],[10,0]]);
      const circle3=make("circle",2,[[0,0],[10,0],[0,10]]);
      const arc3=make("arc",1,[[10,0],[-10,0],[0,10]]);
      const rectangle=make("rectangle",1,[[0,0],[10,10],[5,15]]);
      await sketch.primitives.add(rectangle.type,rectangle.parameters);
      await sketch.complete();
      const feature=await core.solid.extrude(await sketch.regions.only(),{length1:1});
      const angledArea=(await (await scene.bodies.get(feature.newSolids[0].id)).properties()).volume.value;
      const tangent=await scene.sketches.create(scene.construction.builtin.planes.xy);
      const x=await tangent.primitives.add("line",{from:[0,0],to:[20,0],construction:true});
      const y=await tangent.primitives.add("line",{from:[0,20],to:[0,0],construction:true});
      const z=await tangent.primitives.add("line",{from:[20,0],to:[0,20],construction:true});
      const state=await tangent.state();const curves=[x,y,z].map(l=>state.entities.find(e=>e.reference.id===l.curves[0].id));
      const tangent2=make("circle",3,[[4,4]],{...fields,radius:5},curves.slice(0,2),state);
      const tangent3=make("circle",4,[[5,5]],{...fields,radius:5},curves,state);
      const added=await tangent.primitives.add("circle",tangent3.parameters);
      await tangent.constraints.add("fix",{curves:[...x.curves,...y.curves,...z.curves]});
      for(const line of [x,y,z])await tangent.constraints.add("tangent",{curves:[line.curves[0],added.curves[0]]});
      await tangent.complete();
      const solid=await core.solid.extrude(await tangent.regions.only(),{length1:2});
      const tangentVolume=(await (await scene.bodies.get(solid.newSolids[0].id)).properties()).volume.value;
      return {circle2:circle2.parameters,circle3:circle3.parameters,arc3:arc3.parameters,angledArea,tangentVolume,tangent2:tangent2.parameters,tangent3:tangent3.parameters,
        ellipseCenter:make("ellipse",0,[[5,10],[15,15]]).parameters,ellipseRectangle:make("ellipse",1,[[0,0],[20,10]]).parameters,
        slot3:make("slot",0,[[0,0],[20,0],[20,5]]).parameters,slotCenter:make("slot",1,[[10,0],[20,0]],{...fields,radius:5}).parameters,
        slotCenters:make("slot",2,[[0,0],[20,0]],{...fields,radius:5}).parameters,
        rotatedSlot:make("slot",0,[[0,0],[12,16],[2,11]]).parameters,
        typedTips:make("slot",0,[[0,0],[20,0]],{...fields,radius:4}).parameters,
        invalidSlotRadii:[0,10,11].map(radius=>{try{make("slot",0,[[0,0],[20,0]],{...fields,radius});return false;}catch{return true;}})};
    }finally{await scene.close();core.close();}
  },sdk);
  const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
  near(results.angledArea,100);
  assert.deepEqual(results.circle3.center,[5,5]);near(results.circle3.diameter,Math.sqrt(200));
  near(results.circle2.center[0],5);near(results.circle2.center[1],Math.sqrt(75));
  near(results.arc3.radius,10);near(results.arc3.end-results.arc3.start,180);
  near(results.tangent2.center[0],5);near(results.tangent2.center[1],5);
  near(results.tangent3.diameter/2,20-10*Math.sqrt(2));
  near(results.tangentVolume,2*Math.PI*(20-10*Math.sqrt(2))**2);
  assert.deepEqual(results.ellipseCenter.center,[5,10]);assert.equal(results.ellipseCenter.major,10);assert.equal(results.ellipseCenter.minor,5);
  assert.deepEqual(results.ellipseRectangle.center,[10,5]);
  assert.deepEqual(results.slot3.from,[5,0]);assert.deepEqual(results.slot3.to,[15,0]);assert.equal(results.slot3.radius,5);
  assert.deepEqual(results.slotCenter,results.slotCenters);
  assert.deepEqual(results.rotatedSlot.from,[3,4]);assert.deepEqual(results.rotatedSlot.to,[9,12]);near(results.rotatedSlot.radius,5);
  assert.deepEqual(results.typedTips.from,[4,0]);assert.deepEqual(results.typedTips.to,[16,0]);
  assert.deepEqual(results.invalidSlotRadii,[true,true,true]);
  const seeds = await page.evaluate(async sdk => {
    const { Core } = await import(sdk);
    const { editorTransport } = await import("/src/runtime/transport.ts");
    const { SketchTool } = await import("/src/tools/sketch.ts");
    const { Viewport } = await import("/src/viewport.ts");
    const { lightTheme } = await import("/src/theme.ts");
    const core = new Core(editorTransport(() => {}));
    const scene = await core.scene.create("Drawing dimension units", { length: "in", angle: "rad" });
    const host = document.createElement("div"), panel = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:640px;height:480px";
    document.body.append(host, panel);
    const viewport = new Viewport(host, () => {}, () => {}, lightTheme);
    const tool = new SketchTool(panel, scene, viewport, { changed() {}, proxy() {}, visibility() {}, status() {} });
    const idle = async () => {
      const deadline = performance.now() + 10000;
      while (tool.pending || tool.updateRunning || tool.previewQueued) {
        if (performance.now() > deadline) throw new Error("Slot preview did not settle");
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    };
    try {
      await tool.start(undefined, scene.construction.builtin.planes.xy); await idle();
      const samples = [];
      for (const zoom of [1, 8]) {
        viewport.restoreView({ ...viewport.captureView(), zoom });
        tool.choose("circle"); tool.setNumericField("sketch-radius", 500); tool.escape();
        tool.choose("slot", 1);
        for (const point of [[0, 0], [100, 0]]) {
          tool.click({ point, picks: [], additive: false, client: [0, 0] }); await idle();
        }
        const preview = await tool.sketch.state({ preview: true });
        samples.push({ pixel: viewport.pixelLength, text: tool.input("sketch-radius").value,
          radii: preview.entities.filter(e => e.geometry.type === "arc").map(e => e.geometry.radius), ready: tool.ready });
        tool.escape(); await idle();
      }
      tool.choose("arc");
      for (const point of [[0, 0], [25.4, 0]]) {
        tool.click({ point, picks: [], additive: false, client: [0, 0] }); await idle();
      }
      tool.move([0, 25.4]); await idle();
      return { samples, radius: tool.input("sketch-radius").value, angle: tool.input("sketch-angle").value,
        degrees: await tool.number("sketch-angle", "angle") };
    } finally {
      await tool.cancel(); tool.close(); viewport.orbit.dispose(); viewport.renderer.dispose();
      host.remove(); panel.remove(); await scene.close(); core.close();
    }
  }, sdk);
  for (const seed of seeds.samples) {
    assert.equal(seed.ready, false); assert.equal(seed.radii.length, 2);
    seed.radii.forEach(radius => near(radius, Math.min(2 * seed.pixel, 1)));
    assert.match(seed.text, / in$/);
    assert.ok(Math.abs(parseFloat(seed.text) * 25.4 - seed.radii[0]) <= 0.00005 * 25.4);
  }
  assert.ok(seeds.samples[1].radii[0] < seeds.samples[0].radii[0], "Zoomed-in slot seeds stay small on screen");
  assert.equal(seeds.radius, "1 in"); assert.equal(seeds.angle, "1.5708 rad"); near(seeds.degrees, 90);
  console.log("Sketch construction variants: angled rectangle, point/tangent circles, three-point arc, ellipse and slot variants passed");
}

export async function testSketchDrawingStages(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addScriptTag({ path: "tests/editor/rectangle.js" });
  await page.getByText("File", { exact: true }).click();
  await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts"), original = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) { window.geometryCheck = this; return original.apply(this, args); };
    try { document.querySelector("#new-sketch").click(); }
    finally { SketchTool.prototype.start = original; }
  });
  const idle = () => page.waitForFunction(() => { const t = window.geometryCheck; return t && !t.pending && !t.updateRunning && !t.previewQueued && !t.creating; });
  const screen = xy => page.evaluate(xy => {
    const { viewport, state } = window.geometryCheck, frame = state.frame;
    viewport.camera.updateMatrixWorld();
    const p = viewport.camera.position.clone().fromArray(frame.origin)
      .addScaledVector(viewport.camera.position.clone().fromArray(frame.u), xy[0])
      .addScaledVector(viewport.camera.position.clone().fromArray(frame.v), xy[1]).project(viewport.camera);
    const r = document.querySelector("#model-canvas").getBoundingClientRect();
    return [r.x + (p.x + 1) * r.width / 2, r.y + (1 - p.y) * r.height / 2];
  }, xy);
  const click = async xy => { await page.mouse.click(...await screen(xy)); await idle(); };
  const move = async xy => { await page.mouse.move(...await screen(xy)); await idle(); };
  const state = () => page.evaluate(() => {
    const t = window.geometryCheck;
    return { state: t.state, display: t.viewport.sketchDisplayState[1], tool: t.tool, valid: t.draftValid, error: t.get("sketch-error").textContent };
  });
  const near = (a,b) => assert.ok(Math.abs(a-b)<1e-5, `${a} != ${b}`);
  const choose = async (tool, name) => {
    const button = page.locator(`#sketch-ribbon [data-tool="${tool}"]`);
    if (await button.getAttribute("aria-pressed") !== "true") await button.click();
    if (name) await page.getByRole("group", { name: "Tool variants" }).getByRole("button", { name, exact: true }).click();
    await idle();
    if (["rectangle","circle","arc","ellipse","slot","spline"].includes(tool)) assert.ok(await page.locator(".sketch-variants button").evaluateAll(buttons => buttons.every(b => b.dataset.tooltip && b.getAttribute("aria-label") === b.dataset.tooltip && b.querySelector("svg .icon-point") && b.querySelector("svg [class]"))));
    assert.equal(await page.locator('.sketch-variants [aria-pressed="true"]').count(), 1);
  };
  try {
    await page.evaluate(() => chooseSketchPlane("XY")); await idle();
    await page.getByRole("button", { name: "Snap to geometry", exact: true }).click();
    await choose("arc", "Center, point and angle");
    const iconColors = () => page.evaluate(() => {
      const style = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      return { point: style(".sketch-variants .icon-point","fill"), edge: style(".sketch-variants .icon-edge","stroke"),
        toolbarPoint: style('[data-tool="point"] .icon-edge-fill',"fill"), toolbarFill: style("#new-sketch .icon-fill","fill"),
        extrude: style("#extrude .icon-surface-fill","fill") };
    });
    const originalColors=await iconColors();assert.notEqual(originalColors.point,originalColors.edge);
    assert.equal(originalColors.point, "rgb(213, 94, 0)");
    assert.ok(await page.locator(".ribbon .icon-point, .sketch-variants .icon-point").evaluateAll(points => points.every(e => e.getAttribute("fill") === "#d55e00")));
    assert.ok(await page.locator(".ribbon svg, .sketch-variants svg").evaluateAll(icons=>icons.length>25&&icons.every(svg=>[svg,...svg.querySelectorAll("[fill], [stroke]")].every(e=>!["fill","stroke"].some(a=>/^#/.test(e.getAttribute(a)||""))||e.classList.length))));
    await page.evaluate(async()=>{const {editorTheme}=await import("/src/theme.ts");window.geometryTheme=editorTheme.definition;editorTheme.set({...editorTheme.definition,colors:{...editorTheme.definition.colors,geometrySelected:"#bb3300",sketchEdge:"#123456",sketch:"#ccddee",surface:"#aabbcc"}});});
    assert.deepEqual(await iconColors(),{point:"rgb(187, 51, 0)",edge:"rgb(18, 52, 86)",toolbarPoint:"rgb(18, 52, 86)",toolbarFill:"rgb(204, 221, 238)",extrude:"rgb(170, 187, 204)"});
    await page.evaluate(async()=>{(await import("/src/theme.ts")).editorTheme.set(window.geometryTheme);delete window.geometryTheme;});
    assert.deepEqual(await iconColors(),originalColors);
    const base = (await state()).state;
    await click([-15, 10]); await move([-5, 10]);
    let current = await state();
    assert.deepEqual(current.state, base);
    assert.equal(current.valid, false);
    assert.ok(current.display.curves.some(c => c.entity.id === "draft-axis"));
    await click([-5, 10]);
    assert.equal((await state()).tool, "arc", "Second click must not finish the arc");
    await move([-15, 20]);
    assert.equal(await page.locator("#sketch-radius").inputValue(), "10 mm");
    assert.equal(await page.locator("#sketch-angle").inputValue(), "90 deg");
    assert.ok(await page.locator(".sketch-live-dimensions > input").evaluateAll(fields => fields.length === 4 && fields.every(f =>
      f.getAttribute("aria-label") && !f.hasAttribute("title") && getComputedStyle(f).fontSize === "10px" && getComputedStyle(f).height === "20px")));
    assert.equal(await page.locator(".sketch-live-dimensions label, .sketch-live-dimensions span").count(), 0);
    assert.equal((await state()).valid, true);
    // The final click differs from the last completed preview.
    await click([-20, 15]);
    current = await state(); assert.equal(current.tool, "arc");
    let arc = current.state.entities.find(e => e.geometry.type === "arc").geometry;
    near(arc.radius, 10); near((arc.end - arc.start) * 180 / Math.PI, 135);
    assert.equal(current.state.dimensions.length, 0, "An untyped angle stays undimensioned");

    await choose("arc", "Three points");
    const beforeThree = (await state()).state;
    await click([-10, -10]); await click([10, -10]);
    assert.deepEqual((await state()).state, beforeThree);
    await move([0, 0]); assert.equal((await state()).valid, true);
    await move([0, -20]); assert.equal((await state()).valid, true);
    await click([0, -20]);
    current = await state(); assert.equal(current.tool, "arc");
    arc = current.state.entities.find(e => e.geometry.type === "arc" && !beforeThree.entities.some(old => old.reference.id === e.reference.id)).geometry;
    near(arc.radius, 10); near((arc.end - arc.start) * 180 / Math.PI, 180);
    const arcPoints = current.state.entities.filter(e => [arc.from, arc.to].includes(e.reference.id)).map(e => e.geometry.position);
    assert.ok(arcPoints.some(p => Math.hypot(p[0]+10,p[1]+10)<1e-5));
    assert.ok(arcPoints.some(p => Math.hypot(p[0]-10,p[1]+10)<1e-5));

    await choose("arc", "Center, point and angle");
    await click([15, 10]); await click([20, 10]); await move([15, 15]);
    await page.locator("#sketch-radius").fill("12 / 2");
    await page.locator("#sketch-angle").fill("-120 / 2");
    await page.waitForFunction(() => document.querySelector("#sketch-radius").value === "6 mm");
    await page.locator("#sketch-radius").focus();
    assert.equal(await page.locator("#sketch-radius").inputValue(), "12 / 2");
    await page.waitForFunction(() => document.querySelector("#sketch-angle").value === "-60 deg");
    await page.locator("#sketch-angle").focus();
    assert.equal(await page.locator("#sketch-angle").inputValue(), "-120 / 2");
    await idle(); await click([-10, 15]);
    current = await state();
    assert.equal(current.tool, "arc", JSON.stringify(await page.evaluate(() => { const t=window.geometryCheck;return {error:t.get("sketch-error").textContent,points:t.points,dirty:[...t.dirty],focus:document.activeElement?.outerHTML}; })));
    assert.equal(current.state.dimensions.length, 2);
    near(current.state.dimensions.find(d => d.kind === "radius").computed.value, 6);
    near(current.state.dimensions.find(d => d.kind === "angle").computed.value, -60);

    // A large radius left by another tool must never become a new slot's seed.
    await choose("circle");
    await page.evaluate(()=>{const t=window.geometryCheck;t.setNumericField("sketch-radius",500);t.escape();});
    await choose("slot", "Three points");
    await click([-10, 5]); await click([10, 5]);
    const seeded=await page.evaluate(async()=>{const t=window.geometryCheck,s=await t.sketch.state({preview:true});return {radii:s.entities.filter(e=>e.geometry.type==="arc"&&!t.state.entities.some(old=>old.reference.id===e.reference.id)).map(e=>e.geometry.radius),pixel:t.viewport.pixelLength,ready:t.ready};});
    assert.equal(seeded.radii.length,2);assert.ok(seeded.radii.every(r=>r>0&&r<=2*seeded.pixel&&r<0.3));assert.equal(seeded.ready,false);
    await move([15, 8]);
    assert.equal(await page.locator("#sketch-radius").inputValue(), "3 mm");
    const preview = await page.evaluate(() => window.geometryCheck.sketch.state({ preview: true }));
    let caps = preview.entities.filter(e => e.geometry.type === "arc");
    // Read only additions relative to the committed sketch.
    const committedIds = new Set((await state()).state.entities.map(e => e.reference.id));
    caps = caps.filter(e => !committedIds.has(e.reference.id));
    assert.equal(caps.length, 2); caps.forEach(e => near(e.geometry.radius, 3));
    const centers = caps.map(e => preview.entities.find(p => p.reference.id === e.geometry.center).geometry.position).sort((a,b)=>a[0]-b[0]);
    near(centers[0][0], -7); near(centers[1][0], 7);
    await move([15, 9]); await click([15, 9]);
    current = await state(); assert.equal(current.tool, "slot");
    const newCaps = current.state.entities.filter(e => e.geometry.type === "arc" && !committedIds.has(e.reference.id));
    newCaps.forEach(e => near(e.geometry.radius, 4));
    const newCenters = newCaps.map(e => current.state.entities.find(p => p.reference.id === e.geometry.center).geometry.position).sort((a,b)=>a[0]-b[0]);
    near(newCenters[0][0] - 4, -10); near(newCenters[1][0] + 4, 10);

    await choose("slot", "Center to center");
    const beforeCenters = (await state()).state;
    await click([-10, -5]); await click([10, -5]);
    assert.deepEqual((await state()).state, beforeCenters);
    await move([0, -2]); await page.locator("#sketch-radius").fill("8 / 2"); await idle(); await click([0, -20]);
    current = await state(); assert.equal(current.tool, "slot");
    caps = current.state.entities.filter(e => e.geometry.type === "arc" && !beforeCenters.entities.some(old => old.reference.id === e.reference.id));
    assert.equal(caps.length, 2); caps.forEach(e => near(e.geometry.radius, 4));
    const capCenters = caps.map(e => current.state.entities.find(p => p.reference.id === e.geometry.center).geometry.position).sort((a,b)=>a[0]-b[0]);
    near(capCenters[0][0], -10); near(capCenters[1][0], 10);

    await choose("slot", "Center and line");
    const beforeCentered = (await state()).state;
    await click([0, 15]); await move([10, 15]); await click([10, 15]);
    assert.equal((await state()).tool, "slot", "Centered slots also wait for radius");
    assert.deepEqual((await state()).state, beforeCentered);
    await move([15, 19]); await click([15, 19]);
    current = await state(); assert.equal(current.tool, "slot");
    assert.ok(current.state.entities.some(e => !beforeCentered.entities.some(old => old.reference.id === e.reference.id) && e.construction && e.geometry.type === "point" && Math.hypot(e.geometry.position[0],e.geometry.position[1]-15)<1e-5));

    await page.getByRole("button", { name: "Snap to geometry", exact: true }).click();
    await choose("rectangle", "Centered");
    const beforeRectangle = (await state()).state;
    await click([0, 0]); await move([-8, -7]); await click([-8, -7]);
    current = await state();
    const added = current.state.entities.filter(e => !beforeRectangle.entities.some(old => old.reference.id === e.reference.id));
    assert.equal(added.filter(e => e.geometry.type === "line" && e.construction).length, 2);
    assert.equal(added.filter(e => e.geometry.type === "point" && e.construction).length, 1);
    const rectangleCenter = added.find(e => e.geometry.type === "point" && e.construction);
    assert.ok(current.state.constraints.some(c => c.kind === "coincident" && c.parameters.points.some(p => p.id === "origin") && c.parameters.points.some(p => p.id === rectangleCenter.reference.id)));
    await page.getByRole("button", { name: "Snap to geometry", exact: true }).click();
    // Reapplying a ribbon constraint cannot append duplicates.
    await page.evaluate(() => { const t=window.geometryCheck, c=t.state.constraints.find(c=>c.kind==="perpendicular");t.selected.clear();c.parameters.curves.forEach(r=>t.selected.add(r.id));t.selectionChanged(); });
    const constraintsBefore = (await state()).state;
    await page.locator('[data-constraint="perpendicular"]').click(); await idle();
    assert.deepEqual((await state()).state, constraintsBefore);

    await choose("slot", "Three points");
    const beforeInvalid = (await state()).state;
    await click([-10, 0]); await click([10, 0]); await move([0, 15]);
    assert.match((await state()).error, /diameter/);
    assert.deepEqual((await state()).state, beforeInvalid);
    await page.keyboard.press("Escape"); await idle();
    assert.equal((await state()).tool, "select");
    assert.deepEqual((await state()).state, beforeInvalid);
    await choose("arc", "Three points");
    await click([-10, 0]); await click([10, 0]); await move([0, 10]);
    await page.keyboard.press("Escape"); await idle();
    assert.deepEqual((await state()).state, beforeInvalid);

    await choose("rectangle", "Three points");
    await click([-8, 8]); await click([6, 16]); await move([12, 5]);
    const compactFields = await page.locator(".sketch-live-dimensions > input:visible").evaluateAll(fields => fields.map(f => ({
      name: f.getAttribute("aria-label"), value: f.value, width: f.getBoundingClientRect().width, height: f.getBoundingClientRect().height,
    })));
    assert.deepEqual(compactFields.map(f => f.name), ["Width", "Height"]);
    assert.ok(compactFields.every(f => / mm$/.test(f.value) && f.height === 20 && f.width < 90));
    await page.screenshot({ path: "/private/tmp/pamatcad-compact-drawing-inputs.png" });
    await page.keyboard.press("Escape"); await idle();

    await choose("circle");
    await click([-10, -10]); await move([-6, -10]);
    const radius = page.locator("#sketch-radius");
    assert.equal(await radius.inputValue(), "4 mm");
    await radius.fill("10 / 3"); await idle();
    await radius.evaluate(f => f.blur());
    await page.waitForFunction(() => document.querySelector("#sketch-radius").value === "3.3333 mm");
    near(await page.evaluate(() => window.geometryCheck.number("sketch-radius")), 10 / 3);
    await radius.focus(); assert.equal(await radius.inputValue(), "10 / 3");
    await radius.fill("2 deg"); await idle(); await radius.evaluate(f => f.blur());
    assert.equal((await state()).valid, false);
    assert.equal(await radius.inputValue(), "2 deg", "Invalid formulas remain editable");
    await radius.fill("8 / 2"); await idle();
    // Hold only the blur's evaluation; a newer edit must survive its late response.
    await page.evaluate(() => {
      const scene = window.geometryCheck.scene, evaluate = scene.evaluateFormula;
      scene.evaluateFormula = async function (...args) {
        scene.evaluateFormula = evaluate;
        const result = await evaluate.apply(this, args);
        await new Promise(resolve => { window.releaseField = resolve; });
        return result;
      };
      window.geometryCheck.input("sketch-radius").blur();
    });
    await page.waitForFunction(() => !!window.releaseField);
    await radius.fill("12 / 2"); await idle();
    await page.evaluate(() => { window.releaseField(); delete window.releaseField; });
    assert.equal(await radius.inputValue(), "12 / 2");
    await radius.evaluate(f => f.blur());
    await page.waitForFunction(() => document.querySelector("#sketch-radius").value === "6 mm");
    await page.keyboard.press("Escape"); await idle();

    await choose("arc", "Center, point and angle");
    await click([-10, 0]); await click([0, 0]); await move([-10, 10]);
    await page.locator("#sketch-angle").fill("180 / 2"); await idle();
    await page.evaluate(() => {
      const scene = window.geometryCheck.scene, evaluate = scene.evaluateFormula;
      scene.evaluateFormula = async function (...args) {
        scene.evaluateFormula = evaluate;
        const result = await evaluate.apply(this, args);
        await new Promise(resolve => { window.releaseField = resolve; });
        return result;
      };
      window.geometryCheck.input("sketch-angle").blur();
    });
    await page.waitForFunction(() => !!window.releaseField);
    await choose("circle");
    await choose("arc", "Center, point and angle");
    await page.evaluate(() => { window.releaseField(); delete window.releaseField; });
    assert.equal(await page.locator("#sketch-angle").inputValue(), "0 deg", "A late blur cannot overwrite a new construction");
    await page.keyboard.press("Escape"); await idle();
    assert.deepEqual((await state()).state, beforeInvalid);
    console.log("Sketch variants: icons, arc stages/formulas, slot tips/centers/radius, helpers, duplicate ribbon constraints and Escape passed");
  } catch (error) {
    await page.screenshot({ path: "/private/tmp/pamatcad-geometry-browser-failure.png" });
    throw error;
  } finally {
    await page.evaluate(() => window.geometryCheck?.escape());
    await idle();
    await page.locator("#cancel").click();
    await page.waitForFunction(() => document.querySelector("#new-sketch") && !document.querySelector("#new-sketch").disabled);
  }
}

export async function testSketchDrawingFixes(page) {
  await page.getByText("File", { exact: true }).click(); await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts"), start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) { window.drawingFixes = this; return start.apply(this, args); };
    document.querySelector("#new-sketch").click(); SketchTool.prototype.start = start;
  });
  await page.evaluate(() => chooseSketchPlane("XY"));
  const idle = () => page.waitForFunction(() => { const t = window.drawingFixes; return t.state && !t.pending && !t.updateRunning && !t.creating && !t.viewport.renderPending; });
  const screen = xy => page.evaluate(xy => {
    const t = window.drawingFixes, v = t.viewport, f = t.state.frame, r = document.querySelector("#model-canvas").getBoundingClientRect();
    v.camera.updateMatrixWorld();
    const p = v.camera.position.clone().fromArray(f.origin).addScaledVector(v.camera.position.clone().fromArray(f.u), xy[0]).addScaledVector(v.camera.position.clone().fromArray(f.v), xy[1]).project(v.camera);
    return [r.x + (p.x + 1) * r.width / 2, r.y + (1 - p.y) * r.height / 2];
  }, xy);
  const click = async xy => { await page.mouse.click(...await screen(xy)); await idle(); };
  const move = async xy => { await page.mouse.move(...await screen(xy)); await idle(); };
  const choose = async (tool, mode) => { await page.keyboard.press("Escape"); await page.locator(`[data-tool="${tool}"]`).click(); if (mode) await page.getByRole("group", { name: "Tool variants" }).getByRole("button", { name: mode, exact: true }).click(); await idle(); };
  const state = () => page.evaluate(() => window.drawingFixes.state);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
  try {
    await idle(); await page.getByRole("button", { name: "Snap to geometry", exact: true }).click();
    await choose("line");
    assert.equal(await page.locator("#sketch-tool-empty").textContent(), "Enter to finish, Esc to exit");
    const empty = await state();
    await click([-25, -20]); await move([-15, -20]);
    assert.ok(await page.evaluate(async () => (await window.drawingFixes.sketch.state({ preview: true })).entities.some(e => e.geometry.type === "line")));
    await page.locator("#width").fill("12 mm"); await idle();
    await page.keyboard.press("Escape"); await idle();
    assert.deepEqual((await state()).entities, empty.entities);
    assert.equal(await page.evaluate(() => window.drawingFixes.tool), "select");
    assert.equal(await page.evaluate(async () => { try { await window.drawingFixes.sketch.state({ preview: true }); return false; } catch (e) { return e.details?.code === "PREVIEW_UNAVAILABLE"; } }), true);
    await choose("line");
    await click([-25, -20]); await click([-15, -20]); await click([-15, -10]);
    let s = await state(), lines = s.entities.filter(e => e.geometry.type === "line");
    assert.equal(lines.length, 2);
    assert.ok(s.constraints.some(c => c.kind === "coincident" && c.parameters.points.some(p => p.id === lines[0].geometry.to) && c.parameters.points.some(p => p.id === lines[1].geometry.from)));
    await page.evaluate(() => {
      const primitives = window.drawingFixes.sketch.primitives, add = primitives.add;
      primitives.add = async function (...args) {
        primitives.add = add;
        const result = await add.apply(this, args);
        await new Promise(resolve => { window.releaseLinePreview = resolve; });
        return result;
      };
    });
    await page.mouse.move(...await screen([-5, -10]));
    await page.waitForFunction(() => !!window.releaseLinePreview);
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.releaseLinePreview(); delete window.releaseLinePreview; }); await idle();
    assert.deepEqual((await state()).entities, s.entities);
    assert.equal(await page.evaluate(async () => { try { await window.drawingFixes.sketch.state({ preview: true }); return false; } catch (e) { return e.details?.code === "PREVIEW_UNAVAILABLE"; } }), true);
    await choose("line"); await click([-15, -10]);
    await move([-5, -10]); await page.locator("#model-canvas").press("Enter"); await idle();
    assert.equal((await state()).entities.filter(e => e.geometry.type === "line").length, 2);
    assert.equal(await page.evaluate(() => window.drawingFixes.tool), "line");
    await click([-25, -5]); await move([-20, -5]); await page.locator("#width").fill("7 mm"); await page.locator("#width").press("Enter"); await idle();
    assert.equal(await page.evaluate(() => window.drawingFixes.points.length), 0);
    near((await state()).dimensions[0].computed.value, 7);
    await page.keyboard.press("Escape"); await click([-20, -20]); await page.keyboard.press("Delete"); await idle();
    s = await state(); assert.ok([lines[0].geometry.from, lines[0].geometry.to].every(id => !s.entities.some(e => e.reference.id === id)));
    assert.ok([lines[1].reference.id, lines[1].geometry.from, lines[1].geometry.to].every(id => s.entities.some(e => e.reference.id === id)));

    await choose("circle", "Two points and radius");
    await click([-8, 8]); await click([2, 8]); await move([-3, 12]);
    const radius1 = Number.parseFloat(await page.locator("#sketch-radius").inputValue());
    await move([-3, 16]);
    const radius2 = Number.parseFloat(await page.locator("#sketch-radius").inputValue());
    assert.ok(radius2 > radius1 + 1, "Third cursor position changes the radius");
    await page.locator("#sketch-radius").fill("10 mm"); await move([-3, 17]); await click([-3, 17]);
    near((await state()).entities.find(e => e.geometry.type === "circle").geometry.radius, 10);

    await choose("circle", "Three points"); await click([10, -15]); await click([20, -15]);
    assert.ok(await page.locator("#sketch-radius").isVisible());
    await move([15, -8]); await page.locator("#sketch-radius").fill("8 mm"); await click([15, -8]);
    s = await state(); near(s.entities.filter(e => e.geometry.type === "circle").at(-1).geometry.radius, 8);
    await choose("circle", "Three points"); await click([-20, 15]); await click([-10, 15]);
    await page.locator("#sketch-radius").fill("2 mm"); await click([-15, 20]);
    assert.match(await page.locator("#sketch-error").textContent(), /radius/i);
    await page.locator("#sketch-radius").fill("6 mm"); await click([-12, 22]);
    assert.equal((await state()).entities.filter(e => e.geometry.type === "circle").length, 3);

    const refs = await page.evaluate(async () => {
      const t = window.drawingFixes, s = t.sketch;
      const a = await s.primitives.add("line", { from: [0, 0], to: [20, 0], construction: true });
      const b = await s.primitives.add("line", { from: [0, 0], to: [0, 20], construction: true });
      const c = await s.primitives.add("line", { from: [20, 0], to: [0, 20], construction: true });
      await s.constraints.add("fix", { curves: [...a.curves, ...b.curves, ...c.curves] }); await t.reload();
      return [a.curves[0], b.curves[0], c.curves[0]];
    });
    await choose("circle", "Two tangents and radius"); await click([10, 0]); await click([0, 10]); await move([4, 4]);
    assert.equal(await page.locator("#sketch-radius-label").isVisible(), false);
    assert.ok(await page.locator(".sketch-live-dimensions > #sketch-radius").isVisible());
    await page.locator("#sketch-radius").fill("3 mm"); await move([3, 3]); await click([3, 3]);
    s = await state(); let circle = s.entities.filter(e => e.geometry.type === "circle").at(-1);
    near(circle.geometry.radius, 3);
    assert.equal(s.constraints.filter(c => c.kind === "tangent" && c.parameters.curves.some(r => r.id === circle.reference.id)).length, 2);
    await choose("circle", "Three tangents"); await click([10, 0]); await click([0, 10]); await click([10, 10]); await move([6, 6]); await click([6, 6]);
    s = await state(); circle = s.entities.filter(e => e.geometry.type === "circle").at(-1);
    near(circle.geometry.radius, 20 - 10 * Math.sqrt(2));
    assert.equal(s.constraints.filter(c => c.kind === "tangent" && c.parameters.curves.some(r => r.id === circle.reference.id)).length, 3);

    await page.keyboard.press("Escape");
    await page.evaluate(refs => { const t = window.drawingFixes; refs.slice(0, 2).forEach(r => t.selected.add(r.id)); t.selectionChanged(); }, refs);
    await page.locator('[data-tool="circle"]').click();
    await page.getByRole("button", { name: "Two tangents and radius", exact: true }).click();
    await move([-4, -4]); await page.locator("#sketch-radius").fill("2 mm"); await idle(); await move([-5, -6]); await click([-5, -6]);
    s = await state(); circle = s.entities.filter(e => e.geometry.type === "circle").at(-1);
    near(circle.geometry.radius, 2);
    assert.equal(s.constraints.filter(c => c.kind === "tangent" && c.parameters.curves.some(r => r.id === circle.reference.id)).length, 2);

    await choose("ellipse", "Center, side point and radius"); await click([-20, 0]); await click([-14, 6]); await move([-23, 3]);
    await page.locator("#width").fill("20 mm"); await page.locator("#height").fill("8 mm"); await click([-23, 3]);
    s = await state(); const ellipse = s.entities.find(e => e.geometry.type === "ellipse");
    near(ellipse.geometry.major, 10); near(ellipse.geometry.minor, 4); near(ellipse.geometry.angle, Math.PI / 4);
    const dimensions = s.dimensions.slice(-2); assert.ok(dimensions.every(d => d.kind === "length"));
    assert.deepEqual(dimensions.map(d => d.computed.value), [20, 8]);
    await page.screenshot({ path: "/private/tmp/pamatcad-drawing-fixes.png" });
    for (const [mode, start, end] of [["Center, width and height", [-35, 10], [-28, 13]], ["Rectangle", [-35, -28], [-21, -22]]]) {
      const before = (await state()).entities;
      await choose("ellipse", mode); await click(start); await move(end);
      await page.locator("#width").fill("14 mm"); await page.locator("#height").fill("6 mm"); await click(end);
      s = await state(); const e = s.entities.find(e => e.geometry.type === "ellipse" && !before.some(old => old.reference.id === e.reference.id));
      near(e.geometry.major, 7); near(e.geometry.minor, 3);
      assert.deepEqual(s.dimensions.slice(-2).map(d => [d.kind, d.computed.value]), [["length", 14], ["length", 6]]);
    }
    console.log("Connected lines, Escape cancellation, endpoint removal, circle radius stages/tangent picking, and rotated ellipse axes passed");
  } catch (error) { await page.screenshot({ path: "/private/tmp/pamatcad-drawing-fixes-failure.png" }); throw error; }
  finally { await page.evaluate(() => window.drawingFixes.escape()); await idle(); await page.locator("#cancel").click(); }
}
