import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { readSpec } from "../../tools/docs/spec.mjs";

const extrudeSpec = readSpec(resolve('doc/api/command/solid/extrude/spec.md'));
const extrudeDescription = extrudeSpec.sections.get('Short Description').map(token => token.text ?? '').join(' ').trim();

const require = createRequire(new URL("../../apps/editor/package.json", import.meta.url));
const { createServer } = await import(require.resolve("vite"));
const server = await createServer({ root: resolve("apps/editor"), configFile: resolve("apps/editor/vite.config.ts"),
  mode: "web", server: { host: "127.0.0.1", port: 0, watch: null }, logLevel: "error" });
let browser;
try {
  await server.listen();
  const url = "http://127.0.0.1:" + server.httpServer.address().port;
  browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  page.on("pageerror", error => console.error("PAGE ERROR", error));
  page.setDefaultTimeout(15000);
  await page.goto(url);
  await page.waitForFunction(() => !document.querySelector("#new-sketch").disabled);
  await page.addScriptTag({ path: "tests/editor/rectangle.js" });
  const tooltip = page.locator("#ui-tooltip");
  const hover = async (selector, text) => {
    await page.locator(selector).scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (await tooltip.isHidden() && await page.locator(selector).evaluate(el => el.matches(':hover'))) await page.mouse.move(5, 5);
    await page.locator(selector).hover();
    await page.waitForFunction(text => {
      const tip = document.getElementById("ui-tooltip");
      return !tip.hidden && tip.querySelector('.ui-tooltip-name').textContent === text;
    }, text);
  };
  const coverage = async () => {
    const missing = await page.locator('.ribbon, #tool-panel').evaluateAll(roots => roots.flatMap(root =>
      [...root.querySelectorAll('button, input, select, textarea, h2, .tool-window-resize')]
        .filter(el => el.getClientRects().length && !el.closest('.sketch-live-dimensions') && !el.dataset.tooltip)
        .map(el => el.id || el.outerHTML)));
    assert.deepEqual(missing, []);
    assert.equal(await page.locator('.ribbon [title], #tool-panel [title]').count(), 0);
  };
  await coverage();
  await page.evaluate(() => {
    window.tooltipTimes = [];
    window.tooltipStages = [];
    const tip = document.getElementById('ui-tooltip');
    document.addEventListener('pointerover', () => { window.tooltipStart = performance.now(); }, true);
    new MutationObserver(() => {
      if (!tip.hidden) window.tooltipTimes.push({ text: tip.textContent, time: performance.now() - window.tooltipStart });
      if (!tip.hidden) window.tooltipStages.push({name:tip.querySelector('.ui-tooltip-name').textContent, expanded:tip.classList.contains('ui-tooltip-expanded'), time:performance.now()-window.tooltipStart});
    }).observe(tip, { attributes: true, attributeFilter: ['hidden', 'class'] });
  });
  await hover('#new-sketch', 'New sketch');
  const first = await page.evaluate(() => window.tooltipTimes.at(-1));
  assert.ok(first.time >= 90, 'Initial hover waits 100 ms: ' + JSON.stringify(first));
  await page.waitForTimeout(550);
  assert.equal(await tooltip.locator('.ui-tooltip-description').isVisible(), false, 'Undocumented New sketch remains a label');
  await hover('#extrude', extrudeSpec.title);
  const next = await page.evaluate(() => window.tooltipTimes.at(-1));
  console.log('Tooltip timing', {first, next});
  assert.ok(next.time < 100, 'Nearby tooltip opens immediately: ' + JSON.stringify(next));
  assert.equal(await tooltip.locator('.ui-tooltip-description').isVisible(), false, 'Command initially shows only its name');
  await tooltip.locator('.ui-tooltip-description').waitFor();
  const detailTime = await page.evaluate(name => window.tooltipStages.find(entry => entry.name === name && entry.expanded)?.time, extrudeSpec.title);
  assert.ok(detailTime >= 490 && detailTime < 580, 'Expansion waits 500 ms total, not 500 ms after the label: ' + detailTime);
  assert.equal(await tooltip.locator('.ui-tooltip-description').textContent(), extrudeDescription);
  await tooltip.locator('img').evaluate(img => img.decode());
  assert.deepEqual(await tooltip.locator('img').evaluate(img => ({width:img.naturalWidth,height:img.naturalHeight,background:getComputedStyle(img).backgroundColor})), {width:512,height:256,background:'rgb(255, 255, 255)'});
  await tooltip.screenshot({path:'output/ui-drafts/tooltip-extrude-expanded.png'});
  console.log('Two-stage command timing:', {label:first.time, expanded:detailTime});
  await tooltip.hover();
  await page.waitForTimeout(180);
  assert.ok(await tooltip.isVisible(), 'Hovering the tooltip keeps it open');
  await page.mouse.move(5, 5);
  await tooltip.waitFor({ state: 'hidden' });
  // Leave before the initial timer, then re-enter before its close timer expires.
  await page.waitForTimeout(550);
  await page.locator('#new-sketch').hover();
  await page.mouse.move(5, 5);
  await hover('#new-sketch', 'New sketch');
  await page.locator('#workbench').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'new-sketch');
  assert.ok(await tooltip.isVisible());
  await page.keyboard.press('Escape');
  assert.ok(await tooltip.isHidden());
  assert.equal(await page.locator('#new-sketch').getAttribute('aria-describedby'), null);

  // Moving to another control cancels the old expansion and starts a fresh delay.
  await page.locator('#new-sketch').evaluate(el => el.blur());
  await hover('#extrude', extrudeSpec.title);
  await page.waitForTimeout(200);
  await hover('#new-sketch', 'New sketch');
  await page.waitForTimeout(400);
  assert.equal(await tooltip.locator('.ui-tooltip-description').isVisible(), false);
  await page.evaluate(() => { window.tooltipStages = []; });
  await hover('#extrude', extrudeSpec.title);
  assert.equal(await tooltip.locator('.ui-tooltip-description').isVisible(), false);
  await tooltip.locator('.ui-tooltip-description').waitFor();
  const restarted = await page.evaluate(() => window.tooltipStages.find(entry => entry.expanded)?.time);
  assert.ok(restarted >= 490, 'Each new control restarts its expansion timer');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(550);
  assert.ok(await tooltip.isHidden(), 'Escape cancels pending expansion');

  // Use another existing command to verify generic lookup without artwork.
  await page.locator('#new-sketch').evaluate(el => { el.dataset.tooltipCommand = 'scene.close'; });
  await hover('#new-sketch', 'Close scene');
  await tooltip.locator('.ui-tooltip-description').waitFor();
  assert.equal(await tooltip.locator('.ui-tooltip-description').textContent(), 'Release a scene and its geometry from the engine.');
  assert.ok(await tooltip.locator('img').isHidden(), 'Missing illustration is omitted');
  await page.locator('#new-sketch').evaluate(el => { el.dataset.tooltipCommand = 'sketch.create'; });

  // Keyboard focus starts the same two-stage help without a label delay.
  await page.locator('#new-sketch').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'extrude');
  assert.ok(await tooltip.isVisible());
  assert.equal(await tooltip.locator('.ui-tooltip-description').isVisible(), false);
  await tooltip.locator('.ui-tooltip-description').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#extrude').getAttribute('aria-describedby'), null);
  await page.locator('#extrude').evaluate(el => el.blur());

  const ribbonTools = page.locator('#solid-ribbon .tools');
  await ribbonTools.evaluate(el => Object.assign(el.style, {position:'fixed',bottom:'0px',right:'0px',zIndex:'90'}));
  await hover('#extrude', extrudeSpec.title);
  await tooltip.locator('.ui-tooltip-description').waitFor();
  const expandedBounds = await tooltip.boundingBox(), ribbonBounds = await ribbonTools.boundingBox();
  assert.ok(expandedBounds.x >= 8 && expandedBounds.x + expandedBounds.width <= 1272);
  assert.ok(expandedBounds.y >= 8 && expandedBounds.y + expandedBounds.height < ribbonBounds.y, 'Expanded tooltip flips above the lower ribbon');
  await ribbonTools.evaluate(el => el.removeAttribute('style'));
  await page.keyboard.press('Escape');
  console.log('Two-stage help: document content, loaded illustration, fallbacks, cancellation, keyboard focus and expanded edge placement passed');
  console.log('Solid ribbon: timing, warm switching, hover persistence, re-entry, focus and Escape passed');

  await page.locator('#new-sketch').click();
  const line = '#sketch-ribbon [data-tool="line"]';
  assert.ok(await page.locator(line).isDisabled());
  await hover(line, 'Line');
  assert.ok(await page.locator(line).isDisabled(), 'Hover does not enable the tool');
  await coverage();
  await page.evaluate(() => chooseSketchPlane());
  await page.waitForFunction(() => !document.getElementById('apply').disabled);
  for (const name of ['rectangle', 'circle', 'arc', 'ellipse', 'slot', 'spline', 'text', 'offset', 'rounding', 'scale', 'move']) {
    await page.locator(`#sketch-ribbon [data-tool="${name}"]`).click();
    await coverage();
  }
  await page.locator('#sketch-ribbon [data-tool="rectangle"]').click();
  await hover('.sketch-variants button:first-child', 'Two corners');
  // Programmatic tool changes also remove stale tooltips when no pointerdown occurs.
  await page.locator('#sketch-ribbon [data-tool="circle"]').evaluate(el => el.click());
  await tooltip.waitFor({ state: 'hidden' });
  await hover('.sketch-variants button:first-child', 'Center and radius');
  await page.locator('.tool-window-toggle').click();
  await tooltip.waitFor({ state: 'hidden' });
  await hover('.tool-window-toggle', 'Expand tool window');
  await page.locator('.tool-window-toggle').click();
  await hover('#sketch-construction button:first-child', 'Normal geometry: contributes to closed profiles for solid operations.');
  const appearance = await tooltip.evaluate(el => {
    const css = getComputedStyle(el), r = el.getBoundingClientRect();
    return { background: css.backgroundColor, color: css.color, size: css.fontSize, radius: css.borderRadius,
      inside: r.left >= 8 && r.right <= innerWidth - 8 && r.top >= 8 && r.bottom <= innerHeight - 8 };
  });
  assert.deepEqual(appearance, { background: 'rgb(57, 67, 75)', color: 'rgb(255, 255, 255)', size: '12px', radius: '4px', inside: true });
  await page.screenshot({ path: 'output/ui-drafts/tooltip-editor-sketch.png' });
  await page.evaluate(() => beginRectangleDraft());
  await page.locator('#width').waitFor();
  await page.locator('#width').focus();
  assert.ok(await tooltip.isHidden(), 'Canvas dimensions have no tooltip');
  await page.locator('#width').fill('10');
  await page.locator('#height').fill('10');
  await page.locator('#height').press('Enter');
  await page.waitForFunction(() => !document.getElementById('apply').disabled);
  const doc = await page.locator('#document-tabs [aria-selected="true"]').getAttribute('data-document');
  await hover('#sketch-construction button:first-child', 'Normal geometry: contributes to closed profiles for solid operations.');
  await page.evaluate(() => document.getElementById('menu-new').click());
  await page.waitForFunction(id => document.querySelector('#document-tabs [aria-selected="true"]').dataset.document !== id && !document.getElementById('new-sketch').disabled, doc);
  assert.ok(await tooltip.isHidden(), 'Document switching clears the old tooltip');
  await page.locator(`#document-tabs [data-document="${doc}"]`).click();
  await page.locator('#apply').click();
  await page.waitForFunction(() => !document.getElementById('extrude').disabled);
  console.log('Sketch ribbon/window: disabled buttons, all tool configurations, variants, collapse, document switching, canvas exclusions and appearance passed');

  await page.locator('#extrude').click();
  await page.waitForFunction(() => !document.getElementById('apply').disabled);
  await coverage();
  await page.locator('#extrude-type').selectOption('twoSides');
  await page.locator('#extrude-start').selectOption('offset');
  await coverage();
  await page.locator('#length').fill('2 deg');
  await page.waitForFunction(() => document.getElementById('length').getAttribute('aria-invalid') === 'true');
  await page.keyboard.press('Tab');
  await page.locator('#length').focus();
  await page.waitForFunction(() => !document.getElementById('ui-tooltip').hidden);
  assert.equal(await page.locator('#length').getAttribute('aria-describedby'), 'length-error ui-tooltip');
  await page.locator('#length').fill('15');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#length').getAttribute('aria-describedby'), 'length-error');
  await page.waitForFunction(() => !document.getElementById('apply').disabled);
  await hover('#pick-profiles', 'Select profiles');
  await page.locator('#tool-window-fields').evaluate(el => { el.scrollTop += 120; });
  await tooltip.waitFor({ state: 'hidden' });
  await hover('.tool-window-toggle', 'Collapse tool window');
  await page.setViewportSize({ width: 960, height: 700 });
  await tooltip.waitFor({ state: 'hidden' });
  assert.ok(await tooltip.isHidden(), 'Resize dismisses tooltip');
  // Move the actual tool window to the bottom-right and inspect a long tooltip.
  await page.locator('.tool-window-header h2').focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
  const corner = '.tool-window-resize[data-edge="se"]';
  // The normal viewport ends above the timeline/footer. Position the grip at
  // the actual browser boundary to exercise the tooltip's overflow fallback.
  await page.locator(corner).evaluate(el => Object.assign(el.style, {position:'fixed',right:'0px',bottom:'0px',left:'auto',top:'auto'}));
  await hover(corner, 'Resize tool window (arrow keys)');
  const edge = await page.locator(corner).boundingBox(), tip = await tooltip.boundingBox();
  assert.ok(tip.y + tip.height < edge.y, 'Tooltip flips above a bottom-edge control');
  assert.ok(tip.x >= 8 && tip.x + tip.width <= 952, 'Tooltip fits the horizontal window edges');
  await page.locator('#cancel').click();
  await page.waitForFunction(() => !document.getElementById('new-sketch').disabled);
  console.log('Extrude window: control coverage, field errors, scroll/resize dismissal and edge positioning passed');

  console.log('All tooltip checks passed');
} finally {
  await browser?.close();
  await server.close();
}
