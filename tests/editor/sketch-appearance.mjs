import assert from "node:assert/strict";

export async function testSketchAppearance(page) {
  await page.getByText("File", { exact: true }).click();
  await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled && !document.querySelector("#features").children.length);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts"), start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) { window.appearanceCheck = { tool: this, viewport: this.viewport }; return start.apply(this, args); };
    try { document.querySelector("#new-sketch").click(); } finally { SketchTool.prototype.start = start; }
  });
  await page.evaluate(() => chooseSketchPlane("XY"));
  await page.waitForFunction(() => window.appearanceCheck?.tool.state && !window.appearanceCheck.tool.pending);
  try {
    const noHighlight = page.getByRole("button", { name: "No highlight", exact: true });
    assert.equal(await noHighlight.getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => window.appearanceCheck.tool.options.highlight), "none");
    const result = await page.evaluate(async () => {
      const { tool, viewport } = window.appearanceCheck, s = tool.sketch;
      const selected = await s.primitives.add("circle", { center: [-20, 0], diameter: 10 });
      const free = await s.primitives.add("line", { from: [-35, -25], to: [-22, -12] });
      const partial = await s.primitives.add("line", { from: [-25, 15], to: [-10, 15] });
      await s.constraints.add("horizontal", { curves: partial.curves });
      const constrained = await s.primitives.add("circle", { center: [12, 0], diameter: 10 });
      await s.constraints.add("fix", { points: constrained.points });
      const dimension = await s.dimensions.add("radius", { curve: constrained.curves[0], value: 5, mode: "driving", annotation: { position: [16, 9] } });
      const fixed = await s.primitives.add("line", { from: [-10, -15], to: [10, -15] });
      await s.constraints.add("fix", { curves: fixed.curves });
      await tool.reload(); tool.choose("select");
      tool.selected.add(selected.curves[0].id); tool.selected.add(selected.points[0].id); tool.selectionChanged();
      const { editorTheme, lightTheme } = await import("/src/theme.ts");
      const display = viewport.sketchDisplay;
      const curve = ref => display.children.find(c => c.userData.pick?.id === ref.id && c.isLine);
      const point = ref => display.children.find(c => c.userData.pick?.id === ref.id && c.isPoints);
      const colors = () => [selected, free, partial, constrained, fixed].map(g => curve(g.curves[0]).material.color.getHexString());
      const initial = colors(), normal = curve(free.curves[0]), picked = curve(selected.curves[0]);
      const wide = display.children.find(c => c.isLineSegments2 && c.userData.pick.id === selected.curves[0].id);
      const thin = display.children.find(c => c.isLineSegments2 && c.userData.pick.id === free.curves[0].id), marker = point(selected.points[0]), ordinary = point(free.points[0]);
      const selection = { widths: [thin.material.linewidth, wide.material.linewidth], points: [ordinary.material.size, marker.material.size],
        lineAbove: picked.renderOrder > normal.renderOrder, pointAbove: marker.renderOrder > ordinary.renderOrder, pointsAboveLines: ordinary.renderOrder > picked.renderOrder,
        screenWidth: !wide.material.worldUnits, color: wide.material.color.getHexString() };
      const numeric = tool.state.dimensions.find(d => d.id === dimension.id);
      const { formatDimension } = await import("/src/sketch-dimensions.ts");
      const formats = [1.23456789, 10000.123456, 2, -0.00001, "12.3456789 mm", "2.3456789 rad", "1e-3 in", "width / 3", "20 / 2"].map(formatDimension);
      const labels = display.children.filter(c => c.isSprite && c.userData.pick?.kind === "dimension");
      const labelPixels = labels[0].material.map.image.getContext("2d").getImageData(0, 0, labels[0].material.map.image.width, 36).data;
      let darkPixels = 0;
      for (let i = 0; i < labelPixels.length; i += 4) if (labelPixels[i] < 30 && labelPixels[i + 1] < 30 && labelPixels[i + 2] < 30) darkPixels++;
      editorTheme.set({ ...lightTheme, colors: { ...lightTheme.colors, unconstrained: "#123456", partiallyConstrained: "#234567", constrained: "#345678", fixed: "#456789", geometrySelected: "#56789a" } });
      const themed = colors(); editorTheme.set(lightTheme);
      const withoutFreedom = { ...tool.state, status: { ...tool.state.status, entities: tool.state.status.entities.filter(e => e.entity.id !== constrained.curves[0].id) } };
      display.set(withoutFreedom, tool.proxy, tool.selected, tool.options, lightTheme);
      const missingFreedom = curve(constrained.curves[0]).material.color.getHexString();
      tool.display();
      // The region fill must not wash out selection colors rendered above it.
      viewport.render();
      const selectedPixel = await new Promise(resolve => requestAnimationFrame(() => {
        const snapshot = document.createElement("canvas"), canvas = viewport.renderer.domElement;
        snapshot.width = canvas.width; snapshot.height = canvas.height;
        const context = snapshot.getContext("2d"); context.drawImage(canvas, 0, 0);
        const position = tool.proxy.points.find(p => p.entity.id === selected.points[0].id).position;
        const projected = viewport.camera.position.clone().fromArray(position).project(viewport.camera);
        resolve([...context.getImageData(Math.floor((projected.x + 1) * canvas.width / 2), Math.floor((1 - projected.y) * canvas.height / 2), 1, 1).data]);
      }));
      // Display rounding must not feed back into an automatic drawing or handle value.
      tool.setNumericField("width", 12.345678901);
      const field = { text: tool.input("width").value, value: await tool.number("width") };
      const focus = ["input", "textarea", "select"].map(tag => {
        const input = document.createElement(tag); document.body.append(input); input.focus();
        const outline = getComputedStyle(input).outlineStyle; input.remove(); return outline;
      });
      window.appearanceCheck.refs = { selected, free, partial, constrained, fixed, dimension };
      return { initial, selection, themed, missingFreedom, formats, darkPixels, selectedPixel, field, focus, numeric: numeric.computed.value };
    });
    assert.deepEqual(result.initial, ["d55e00", "1565c0", "007c91", "000000", "7b3fb3"]);
    assert.deepEqual(result.themed, ["56789a", "123456", "234567", "345678", "456789"]);
    assert.deepEqual(result.selection.widths, [1, 2]); assert.deepEqual(result.selection.points, [7, 14]);
    assert.ok(result.selection.lineAbove && result.selection.pointAbove && result.selection.pointsAboveLines && result.selection.screenWidth);
    assert.equal(result.selection.color, "d55e00"); assert.equal(result.missingFreedom, "1565c0");
    assert.deepEqual(result.selectedPixel, [213, 94, 0, 255], "Selected geometry retains its color over the region fill");
    assert.deepEqual(result.formats, ["1.2346", "10000.1235", "2", "0", "12.3457 mm", "2.3457 rad", "0.001 in", "width / 3", "20 / 2"]);
    assert.ok(result.darkPixels > 20, "Dimension numerals have dark pixels on their white label background");
    assert.deepEqual(result.field, { text: "12.3457 mm", value: 12.345678901 });
    assert.deepEqual(result.focus, ["none", "none", "none"]);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: "/private/tmp/pamatcad-sketch-appearance.png" });
    await page.evaluate(() => {
      const { viewport } = window.appearanceCheck;
      window.appearanceCheck.pixelRatio = viewport.renderer.getPixelRatio();
      viewport.renderer.setPixelRatio(2); viewport.render();
    });
    await page.screenshot({ path: "/private/tmp/pamatcad-sketch-appearance-retina.png" });
    await page.evaluate(() => {
      const { viewport, pixelRatio } = window.appearanceCheck;
      viewport.renderer.setPixelRatio(pixelRatio); viewport.render();
    });
    const colors = () => page.evaluate(() => {
      const { refs, viewport } = window.appearanceCheck;
      const color = (ref, type) => viewport.sketchDisplay.children.find(c => c[type] && c.userData.pick?.id === ref.id).material.color.getHexString();
      return {
        curves: [refs.selected, refs.free, refs.partial, refs.constrained, refs.fixed].map(g => color(g.curves[0], "isLineSegments2")),
        points: [refs.selected, refs.free, refs.fixed].map(g => color(g.points[0], "isPoints")),
      };
    });
    const commands = await page.locator("#log summary").count();
    const normal = await colors();
    await page.getByRole("button", { name: "Unconstrained geometry", exact: true }).click();
    assert.deepEqual(await colors(), { curves: ["d55e00", "16a34a", "007c91", "000000", "7b3fb3"], points: ["d55e00", "16a34a", "7b3fb3"] });
    assert.equal(await noHighlight.getAttribute("aria-pressed"), "false");
    await page.getByRole("button", { name: "Constrained geometry", exact: true }).click();
    assert.deepEqual(await colors(), { curves: ["d55e00", "1565c0", "007c91", "16a34a", "16a34a"], points: ["d55e00", "1565c0", "16a34a"] });
    await page.screenshot({ path: "/private/tmp/pamatcad-sketch-highlight.png" });
    await page.evaluate(async () => {
      const { editorTheme, lightTheme } = await import("/src/theme.ts");
      editorTheme.set({ ...lightTheme, colors: { ...lightTheme.colors, geometryHighlight: "#a020c0" } });
    });
    assert.deepEqual(await colors(), { curves: ["d55e00", "1565c0", "007c91", "a020c0", "a020c0"], points: ["d55e00", "1565c0", "a020c0"] });
    await page.evaluate(async () => {
      const { editorTheme, lightTheme } = await import("/src/theme.ts"); editorTheme.set(lightTheme);
    });
    await page.getByRole("button", { name: "Partially constrained geometry", exact: true }).click();
    assert.deepEqual(await colors(), { curves: ["d55e00", "1565c0", "16a34a", "000000", "7b3fb3"], points: normal.points });
    assert.equal(await page.locator('#sketch-highlight [aria-pressed="true"]').count(), 1);
    await page.getByRole("button", { name: "Partially constrained geometry", exact: true }).click();
    assert.deepEqual(await colors(), normal);
    assert.equal(await noHighlight.getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Constrained geometry", exact: true }).click();
    await noHighlight.click();
    assert.deepEqual(await colors(), normal);
    assert.equal(await noHighlight.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#log summary").count(), commands, "Category highlighting and theme changes do not call the core");
    await page.locator("#apply").click();
    await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
    console.log("Sketch appearance: solved/free/fixed colors, category highlights and reset, selection priority, live theme, full-precision presentation, and focus styling passed");
  } finally { await page.evaluate(() => { delete window.appearanceCheck; }); }
}

export async function testConstraintMarkers(page) {
  await page.getByText("File", { exact: true }).click(); await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts"), start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) { window.constraintCheck = { tool: this }; return start.apply(this, args); };
    try { document.querySelector("#new-sketch").click(); } finally { SketchTool.prototype.start = start; }
  });
  await page.evaluate(() => chooseSketchPlane("XY"));
  await page.waitForFunction(() => window.constraintCheck.tool.state && !window.constraintCheck.tool.pending);
  try {
    const fixture = await page.evaluate(async () => {
      const check = window.constraintCheck, t = check.tool, s = t.sketch;
      const line = (from, to) => s.primitives.add("line", { from, to });
      const point = position => s.primitives.add("point", { position });
      const circle = (center, diameter) => s.primitives.add("circle", { center, diameter });
      const refs = {}, constraints = {};
      const add = async (name, kind, parameters) => constraints[name] = await s.constraints.add(kind, parameters);
      refs.a = await line([-45, 30], [-25, 30]); refs.b = await line([-45, 20], [-25, 20]); refs.c = await line([-15, 30], [5, 30]);
      await add("horizontal", "horizontal", { curves: refs.a.curves });
      await add("equal", "equal", { curves: [...refs.a.curves, ...refs.b.curves] });
      await add("parallel", "parallel", { curves: [...refs.a.curves, ...refs.b.curves] });
      await add("collinear", "collinear", { curves: [...refs.a.curves, ...refs.c.curves] });
      refs.mid = await point([-35, 30]); await add("midpoint", "midpoint", { points: refs.mid.points, curves: refs.a.curves });
      await add("horizontalB", "horizontal", { curves: refs.b.curves });
      refs.d = await line([-40, -5], [-25, -5]); refs.e = await line([-40, -5], [-40, 10]);
      await add("coincident", "coincident", { points: [refs.d.points[0], refs.e.points[0]] });
      await add("connectedPerpendicular", "perpendicular", { curves: [...refs.d.curves, ...refs.e.curves] });
      await add("pointOnCurve", "pointOnCurve", { points: [refs.d.points[0]], curves: refs.d.curves });
      refs.f = await line([0, 0], [15, 0]); refs.g = await line([25, -5], [25, 10]);
      await add("separatePerpendicular", "perpendicular", { curves: [...refs.f.curves, ...refs.g.curves] });
      await add("vertical", "vertical", { curves: refs.g.curves });
      refs.circle = await circle([0, -30], 10); refs.circle2 = await circle([20, -30], 10);
      refs.arc = await s.primitives.add("arc", { center: [40, -30], radius: 5, start: 180, end: 270 });
      await add("equalCircles", "equal", { curves: [...refs.circle.curves, ...refs.circle2.curves] });
      await add("equalArc", "equal", { curves: [...refs.circle.curves, ...refs.arc.curves] });
      refs.inner = await circle([0, -30], 4);
      await add("concentric", "concentric", { curves: [...refs.circle.curves, ...refs.inner.curves] });
      refs.tangentLine = await line([-10, -35], [10, -35]);
      await add("lineTangent", "tangent", { curves: [...refs.tangentLine.curves, ...refs.circle.curves] });
      refs.external = await circle([30, -30], 10); refs.internal = await circle([23, -30], 4);
      await add("externalTangent", "tangent", { curves: [...refs.circle2.curves, ...refs.external.curves] });
      await add("internalTangent", "tangent", { curves: [...refs.circle2.curves, ...refs.internal.curves] });
      refs.symA = await point([-5, 15]); refs.symB = await point([5, 15]); refs.axis = await line([0, 10], [0, 20]);
      await add("symmetric", "symmetric", { points: [...refs.symA.points, ...refs.symB.points], curves: refs.axis.curves });
      refs.hA = await point([-45, -20]); refs.hB = await point([-30, -20]);
      refs.vA = await point([-45, -30]); refs.vB = await point([-45, -40]);
      await add("pointHorizontal", "horizontal", { points: [...refs.hA.points, ...refs.hB.points] });
      await add("pointVertical", "vertical", { points: [...refs.vA.points, ...refs.vB.points] });
      await add("fix", "fix", { points: refs.hA.points });
      await t.reload(); t.choose("select");
      t.viewport.span = 110; t.viewport.resize(); t.viewport.alignSketch();
      check.refs = refs; check.constraints = constraints;
      check.state = await s.state(); check.proxy = await s.getProxy({ regions: false });
      return { refs, constraints };
    });
    await page.waitForFunction(() => [...window.constraintCheck.tool.viewport.sketchDisplay.constraintSprites.values()].every(s => s.material.map.image.complete));
    const read = () => page.evaluate(async () => {
      const check = window.constraintCheck, t = check.tool, v = t.viewport, d = v.sketchDisplay;
      v.camera.updateMatrixWorld(); v.renderFrame();
      const r = v.host.getBoundingClientRect();
      const project = p => { const q = p.clone().project(v.camera); return [r.x + (q.x + 1) * r.width / 2, r.y + (1 - q.y) * r.height / 2]; };
      const markers = [...d.constraintSprites.values()].map(sprite => {
        const [x, y] = project(sprite.position), right = v.camera.position.clone().setFromMatrixColumn(v.camera.matrixWorld, 0).multiplyScalar(sprite.scale.x / 2);
        const edge = project(sprite.position.clone().add(right));
        return { id: sprite.userData.pick.id, kind: sprite.userData.icon, bucket: sprite.userData.bucket, x, y, size: (edge[0] - x) * 2, order: sprite.renderOrder, svg: decodeURIComponent(sprite.material.map.image.src.split(",")[1]) };
      });
      const anchors = d.buckets.map(b => ({ key: b.key, kind: b.kind, point: project(b.anchor), world: b.anchor.toArray(), ids: b.constraints.map(c => c.id) }));
      const geometryOrder = Math.min(...d.children.filter(n => n.userData.pick?.kind === "geometry").map(n => n.renderOrder));
      return { markers, anchors, geometryOrder };
    });
    let result = await read();
    const markersFor = name => result.markers.filter(m => m.id === fixture.constraints[name].id);
    for (const name of ["equal", "parallel", "collinear", "separatePerpendicular", "equalCircles", "equalArc", "symmetric", "pointHorizontal", "pointVertical"]) assert.equal(markersFor(name).length, 2, name);
    for (const name of ["horizontal", "horizontalB", "midpoint", "connectedPerpendicular", "coincident", "pointOnCurve", "vertical", "concentric", "lineTangent", "externalTangent", "internalTangent", "fix"]) assert.equal(markersFor(name).length, 1, name);
    assert.equal(markersFor("coincident")[0].bucket, markersFor("connectedPerpendicular")[0].bucket);
    assert.equal(markersFor("coincident")[0].bucket, markersFor("pointOnCurve")[0].bucket);
    assert.equal(markersFor("externalTangent")[0].bucket, markersFor("internalTangent")[0].bucket);
    const anchorFor = name => result.anchors.find(b => b.ids.includes(fixture.constraints[name].id));
    assert.deepEqual(anchorFor("lineTangent").world.map(n => Math.round(n * 1e6) / 1e6), [0, -35, 0]);
    assert.deepEqual(anchorFor("externalTangent").world.map(n => Math.round(n * 1e6) / 1e6), [25, -30, 0]);
    assert.deepEqual(anchorFor("concentric").world.map(n => Math.round(n * 1e6) / 1e6), [0, -30, 0]);
    for (const [name, count, columns, rows] of [["a", 5, 3, 2], ["b", 3, 2, 2]]) {
      const icons = result.markers.filter(m => m.bucket === "curve:" + fixture.refs[name].curves[0].id);
      assert.equal(icons.length, count);
      const xs = [...new Set(icons.map(m => m.x.toFixed(4)))].map(Number).sort((a, b) => a - b);
      const ys = [...new Set(icons.map(m => m.y.toFixed(4)))].map(Number).sort((a, b) => a - b);
      assert.equal(xs.length, columns); assert.equal(ys.length, rows);
      assert.ok(xs.slice(1).every((x, i) => Math.abs(x - xs[i] - 17) < 1e-3));
      assert.ok(ys.slice(1).every((y, i) => Math.abs(y - ys[i] - 17) < 1e-3));
    }
    // Compare every SVG shape with the existing ribbon artwork, not a second symbol table.
    const shapes = await page.evaluate(() => {
      const parser = new DOMParser();
      return [...window.constraintCheck.tool.viewport.sketchDisplay.constraintSprites.values()].map(s => {
        const svg = parser.parseFromString(decodeURIComponent(s.material.map.image.src.split(",")[1]), "image/svg+xml");
        const ribbon = document.querySelector(`[data-constraint="${s.userData.icon}"] svg`);
        const geometry = root => [...root.querySelectorAll("path,circle,rect,line,polyline,polygon,ellipse")].map(n => ({ tag: n.tagName, attributes: Object.fromEntries([...n.attributes].filter(a => a.name !== "xmlns").map(a => [a.name, a.value])) }));
        return { kind: s.userData.icon, actual: geometry(svg), expected: geometry(ribbon) };
      });
    });
    for (const shape of shapes) assert.deepEqual(shape.actual, shape.expected, shape.kind + " artwork");
    assert.equal(new Set(shapes.map(s => s.kind)).size, 13);
    assert.match(markersFor("collinear")[0].svg, /icon-geometry-highlight\{stroke:#16a34a\}/);
    const checkPlacement = result => {
      for (const m of result.markers) {
        assert.ok(Math.abs(m.size - 14) < 1e-5, m.kind + " stays 14 CSS pixels");
        assert.ok(m.order < result.geometryOrder, "Geometry and intersections draw above constraint icons");
      }
      for (const anchor of result.anchors.filter(b => b.kind === "point")) {
        const icons = result.markers.filter(m => m.bucket === anchor.key);
        assert.ok(Math.abs(Math.min(...icons.map(m => m.x)) - 7 - anchor.point[0] - 6) < 1e-5);
        assert.ok(Math.abs(Math.max(...icons.map(m => m.y)) + 7 - anchor.point[1] + 6) < 1e-5);
      }
    };
    checkPlacement(result);
    await page.mouse.move(5, 5); await page.screenshot({ path: "/private/tmp/pamatcad-constraint-markers.png" });
    const stable = result.markers.map(({ id, bucket, x, y }) => [id, bucket, x, y]);
    await page.evaluate(() => { const t = window.constraintCheck.tool; t.selected.add(window.constraintCheck.constraints.collinear.id); t.selectionChanged(); });
    result = await read();
    assert.deepEqual(result.markers.map(({ id, bucket, x, y }) => [id, bucket, x, y]), stable, "Selection must not reshuffle buckets");
    assert.ok(markersFor("collinear").every(m => m.svg.includes(".icon-solid-edge{stroke:#d55e00}")));
    await page.evaluate(async () => {
      const { editorTheme, lightTheme } = await import("/src/theme.ts");
      const t = window.constraintCheck.tool; t.selected.clear(); t.selectionChanged();
      editorTheme.set({ ...lightTheme, colors: { ...lightTheme.colors, edge: "#123456", geometryHighlight: "#654321" } });
    });
    result = await read();
    assert.match(markersFor("collinear")[0].svg, /icon-solid-edge\{stroke:#123456\}/);
    assert.match(markersFor("collinear")[0].svg, /icon-geometry-highlight\{stroke:#654321\}/);
    await page.evaluate(async () => {
      const { editorTheme, lightTheme } = await import("/src/theme.ts"); editorTheme.set(lightTheme);
      const v = window.constraintCheck.tool.viewport; window.constraintCheck.view = v.captureView();
    });
    for (const mode of ["orthographic", "perspective"]) {
      await page.evaluate(mode => {
        const v = window.constraintCheck.tool.viewport;
        v.restoreView({ ...window.constraintCheck.view, mode, position: [30, 45, 120], target: [0, 0, 0], up: [0, 1, 0], zoom: 1.4 });
      }, mode);
      checkPlacement(await read());
    }
    await page.evaluate(() => { const v = window.constraintCheck.tool.viewport; v.restoreView(window.constraintCheck.view); v.renderer.setPixelRatio(2); });
    checkPlacement(await read());
    await page.screenshot({ path: "/private/tmp/pamatcad-constraint-markers-retina.png" });
    await page.evaluate(() => window.constraintCheck.tool.viewport.renderer.setPixelRatio(devicePixelRatio));
    const arc = await page.evaluate(async () => {
      const { constraintBuckets } = await import("/src/sketch-constraint-layout.ts"), { tool: t, refs } = window.constraintCheck;
      const ring = state => constraintBuckets(state, t.proxy).find(b => b.key === "curve:" + refs.arc.curves[0].id).ring.map(p => p.toArray());
      const changed = { ...t.state, entities: t.state.entities.map(e => e.geometry.type === "arc" ? { ...e, geometry: { ...e.geometry, start: 0.1, end: 2.7 } } : e) };
      return { before: ring(t.state), after: ring(changed) };
    });
    assert.deepEqual(arc.after, arc.before, "Arc sweep does not move its circle bucket");
    const moved = await page.evaluate(async () => {
      const { tool: t, refs } = window.constraintCheck;
      await t.sketch.drag(refs.hB.points[0], [-27, -20]); await t.reload();
      return t.viewport.sketchDisplay.buckets.find(b => b.constraints.some(c => c.id === window.constraintCheck.constraints.pointHorizontal.id) && b.anchor.x > -40).anchor.toArray();
    });
    assert.ok(Math.abs(moved[0] + 27) < 1e-6, "Point buckets follow geometry edits");
    checkPlacement(await read());
    // Nearby strokes, points and dimension labels must not push a bucket away.
    result = await read();
    const anchored = result.markers.map(({ id, bucket, x, y }) => [id, bucket, x, y]);
    const obstruction = await page.evaluate(async marker => {
      const { tool: t, refs } = window.constraintCheck, v = t.viewport;
      const p = v.point({ clientX: marker.x, clientY: marker.y });
      await t.sketch.primitives.add("line", { from: [p[0] - 3, p[1]], to: [p[0] + 3, p[1]] });
      await t.sketch.primitives.add("line", { from: [p[0], p[1] - 3], to: [p[0], p[1] + 3] });
      const point = await t.sketch.primitives.add("point", { position: p });
      await t.sketch.dimensions.add("length", { line: refs.a.curves[0], mode: "driven", annotation: { position: [p[0] + 3, p[1] + 3] } });
      await t.reload(); v.renderFrame();
      return { point: point.points[0], picks: v.sketchPicks({ clientX: marker.x, clientY: marker.y }) };
    }, result.markers.find(m => m.kind === "equal"));
    result = await read();
    assert.deepEqual(result.markers.map(({ id, bucket, x, y }) => [id, bucket, x, y]), anchored);
    assert.equal(obstruction.picks[0].kind, "geometry");
    assert.ok(obstruction.picks.some(p => p.id === obstruction.point.id));
    assert.ok(obstruction.picks.some(p => p.kind === "constraint"), "The overlap picker retains access to constraint icons");
    const unchanged = await page.evaluate(async () => ({ before: window.constraintCheck.state, after: await window.constraintCheck.tool.sketch.state() }));
    assert.deepEqual(unchanged.after.constraints, unchanged.before.constraints, "Display and view changes preserve constraints");
    const toggle = page.getByRole("button", { name: "Show constraints", exact: true });
    await toggle.click();
    assert.equal(await page.evaluate(() => window.constraintCheck.tool.viewport.sketchDisplay.constraintSprites.size), 0);
    await toggle.click(); result = await read();
    // Use a real canvas click on a duplicate marker, followed by keyboard deletion.
    const target = markersFor("collinear").at(-1);
    await page.mouse.click(target.x, target.y);
    await page.waitForFunction(id => window.constraintCheck.tool.selected.has(id), target.id);
    await page.keyboard.press("Delete");
    await page.waitForFunction(id => !window.constraintCheck.tool.state.constraints.some(c => c.id === id) && !window.constraintCheck.tool.pending, target.id);
    assert.equal((await read()).markers.filter(m => m.id === target.id).length, 0);
    await page.locator("#apply").click(); await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
    console.log("Constraint markers: 13 shared SVGs, geometry buckets, both-point H/V, 3/5 grids, tangencies, anchored overlap, view/theme/density updates and picking/deletion passed");
  } finally {
    await page.evaluate(async () => { const { editorTheme, lightTheme } = await import("/src/theme.ts"); editorTheme.set(lightTheme); delete window.constraintCheck; });
  }
}

export async function testConstraintRelations(page) {
  await page.getByText("File", { exact: true }).click(); await page.locator("#menu-new").click();
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
  await page.evaluate(async () => {
    const { SketchTool } = await import("/src/tools/sketch.ts"), start = SketchTool.prototype.start;
    SketchTool.prototype.start = function (...args) { window.relationCheck = { tool: this }; return start.apply(this, args); };
    try { document.querySelector("#new-sketch").click(); } finally { SketchTool.prototype.start = start; }
  });
  await page.evaluate(() => chooseSketchPlane("XY"));
  await page.waitForFunction(() => window.relationCheck.tool.state && !window.relationCheck.tool.pending);
  try {
    const refs = await page.evaluate(async () => {
      const check = window.relationCheck, t = check.tool, s = t.sketch;
      const a = await s.primitives.add("line", { from: [-20, 0], to: [-5, 0] });
      const b = await s.primitives.add("line", { from: [-5, 0], to: [10, 0] });
      const c = await s.primitives.add("line", { from: [-5, 0], to: [-5, 15] });
      const d = await s.primitives.add("line", { from: [-10, -5], to: [0, 5] });
      const h = await s.constraints.add("horizontal", { curves: a.curves });
      const equal = await s.constraints.add("equal", { curves: [...a.curves, ...b.curves] });
      const parallel = await s.constraints.add("parallel", { curves: [...a.curves, ...b.curves] });
      const ab = await s.constraints.add("coincident", { points: [a.points[1], b.points[0]] });
      const bc = await s.constraints.add("coincident", { points: [b.points[0], c.points[0]] });
      const on = await s.constraints.add("pointOnCurve", { points: [b.points[0]], curves: d.curves });
      const first = await s.primitives.add("spline", { points: [[-20, -20], [-10, -15], [0, -20]], fit: true });
      const second = await s.primitives.add("spline", { points: [[0, -20], [10, -15], [20, -20]] });
      await s.splines.join({ from: first.points[2], to: second.points[0] });
      const support = await s.primitives.add("line", { from: [-5, -20], to: [5, -20] });
      const splineOn = await s.constraints.add("pointOnCurve", { points: [second.points[0]], curves: support.curves });
      await t.reload(); t.choose("select"); check.before = await s.state();
      return { a, b, c, d, h, equal, parallel, ab, bc, on, first, second, support, splineOn };
    });
    const select = async ids => {
      await page.evaluate(ids => { const t = window.relationCheck.tool; t.selected.clear(); ids.forEach(id => t.selected.add(id)); t.selectionChanged(); }, ids);
      return page.evaluate(() => {
        const t = window.relationCheck.tool, d = t.viewport.sketchDisplay;
        const geometry = Object.fromEntries(d.children.filter(n => n.isLineSegments2 || n.isPoints).map(n => [n.userData.pick.id,
          { color: n.material.color.getHexString(), size: n.material.linewidth ?? n.material.size }]));
        const constraints = Object.fromEntries([...d.constraintSprites.values()].map(n => [n.userData.pick.id,
          decodeURIComponent(n.material.map.image.src.split(",")[1]).match(/\.icon-solid-edge\{stroke:([^}]+)/)[1]]));
        return { geometry, constraints, selected: [...t.selected] };
      });
    };
    let view = await select([refs.a.id]);
    assert.deepEqual(view.selected, [refs.a.id]);
    for (const c of [refs.h, refs.equal, refs.parallel, refs.ab]) assert.equal(view.constraints[c.id], "#eaaf80");
    for (const c of [refs.bc, refs.on]) assert.equal(view.constraints[c.id], "#65727b", "A line does not inherit constraints through another coincident point");
    assert.deepEqual(view.geometry[refs.a.id], { color: "d55e00", size: 2 });
    assert.notEqual(view.geometry[refs.b.id].color, "eaaf80", "Selecting geometry only highlights its constraints");
    view = await select([refs.a.points[1].id]);
    assert.equal(view.constraints[refs.ab.id], "#eaaf80");
    for (const c of [refs.h, refs.equal, refs.parallel]) assert.equal(view.constraints[c.id], "#65727b", "Point selection does not inherit line constraints");
    for (const constraint of [refs.ab, refs.on]) {
      view = await select([constraint.id]); assert.deepEqual(view.selected, [constraint.id]);
      assert.equal(view.constraints[constraint.id], "#d55e00");
      for (const line of [refs.a, refs.b, refs.c, refs.d]) assert.deepEqual(view.geometry[line.id], { color: "eaaf80", size: 1.5 });
      for (const p of [refs.a.points[1], refs.b.points[0], refs.c.points[0]]) assert.deepEqual(view.geometry[p.id], { color: "eaaf80", size: 10.5 });
      assert.notEqual(view.geometry[refs.first.id].color, "eaaf80");
    }
    view = await select([refs.equal.id]);
    for (const line of [refs.a, refs.b]) assert.equal(view.geometry[line.id].color, "eaaf80");
    for (const line of [refs.c, refs.d]) assert.notEqual(view.geometry[line.id].color, "eaaf80", "Ordinary constraint relations do not spread through coincidence");
    view = await select([refs.ab.id, refs.a.id]);
    assert.deepEqual(view.geometry[refs.a.id], { color: "d55e00", size: 2 });
    assert.equal(view.geometry[refs.b.id].color, "eaaf80");
    view = await select([refs.splineOn.id]);
    for (const curve of [refs.first, refs.second, refs.support]) assert.deepEqual(view.geometry[curve.id], { color: "eaaf80", size: 1.5 });
    await select([refs.ab.id]);
    await page.waitForFunction(() => [...window.relationCheck.tool.viewport.sketchDisplay.constraintSprites.values()].every(n => n.material.map.image.complete));
    await page.mouse.move(5, 5); await page.screenshot({ path: "/private/tmp/pamatcad-related-constraints.png" });
    await page.evaluate(async () => { const { editorTheme, lightTheme } = await import("/src/theme.ts"); editorTheme.set({ ...lightTheme, colors: { ...lightTheme.colors, geometrySelected: "#204060" } }); });
    view = await select([refs.ab.id]);
    assert.equal(view.geometry[refs.a.id].color, "90a0b0"); assert.equal(view.constraints[refs.ab.id], "#204060");
    await page.evaluate(async () => { const { editorTheme, lightTheme } = await import("/src/theme.ts"); editorTheme.set(lightTheme); });
    assert.equal(await page.evaluate(async () => JSON.stringify(await window.relationCheck.tool.sketch.state()) === JSON.stringify(window.relationCheck.before)), true, "Half-selection never mutates the model");
    await select([refs.ab.id]);
    await page.locator("#model-canvas").focus(); await page.keyboard.press("Delete");
    await page.waitForFunction(id => !window.relationCheck.tool.pending && !window.relationCheck.tool.state.constraints.some(c => c.id === id), refs.ab.id);
    const after = await page.evaluate(() => ({ state: window.relationCheck.tool.state, before: window.relationCheck.before }));
    assert.deepEqual(after.state.entities, after.before.entities, "Deleting a selected constraint never deletes half-selected geometry");
    assert.deepEqual(after.state.constraints.map(c => c.id).sort(), after.before.constraints.filter(c => c.id !== refs.ab.id).map(c => c.id).sort());
    await page.locator("#apply").click(); await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
    console.log("Constraint relations: directional endpoint inheritance, coincidence chains, point-on-curve, shared spline endpoints, visual-only selection, theme and safe deletion passed");
  } finally { await page.evaluate(async () => { const { editorTheme, lightTheme } = await import("/src/theme.ts"); editorTheme.set(lightTheme); delete window.relationCheck; }); }
}
