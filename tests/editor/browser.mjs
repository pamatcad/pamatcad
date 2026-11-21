import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { testEditorTheme } from "./theme.mjs";
import { testSceneBrowser } from "./scene-browser.mjs";
import { testLoadingScreen } from "./loading.mjs";
import { testDocumentTabs } from "./document-tabs.mjs";
import { testExtrudeEditor } from "./extrude.mjs";
import { testToolInputs } from "./tool-inputs.mjs";

const root = resolve("build/web");
const types = {
  ".wasm": "application/wasm",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, "." + new URL(req.url, "http://localhost").pathname);
    if (path !== root && !path.startsWith(root + sep)) throw new Error();
    const file = path === root ? resolve(root, "index.html") : path;
    const contents = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(contents);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.CHROME_BIN ? undefined : "chrome",
    executablePath: process.env.CHROME_BIN,
    args: ["--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  page.on("pageerror", (error) => console.error(error));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.addScriptTag({ path: "tests/editor/rectangle.js" });
  console.log(await page.evaluate(() => testRectangleEditor()));
  await page.addScriptTag({ path: "tests/editor/output.js" });
  const popup = page.waitForEvent("popup");
  await Promise.all([popup, page.evaluate(() => testOutputDock())]);
  console.log("Detached console, live CAD log and scene tree, docking, and window close passed");
  await page.addScriptTag({ path: "tests/editor/documents.js" });
  console.log(await page.evaluate(() => testDocumentEditor()));
  if (process.env.PAMATCAD_SCREENSHOT) await page.screenshot({ path: process.env.PAMATCAD_SCREENSHOT });

  // Draw and select through the actual canvas in a fresh document.
  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: "New scene" }).click();
  await page.waitForFunction(() => document.querySelector("#features").children.length === 0);
  await page.getByRole("button", { name: "New sketch" }).click();
  const canvas = page.locator("#model-canvas");
  const bounds = await canvas.boundingBox();
  const cameraButton = page.getByRole("button", { name: "Camera mode" });
  const cameraMenu = page.getByRole("radiogroup", { name: "Camera mode" });
  const chooseProjection = async (name) => {
    await cameraButton.click();
    await cameraMenu.getByRole("radio", { name, exact: true }).click();
    assert.equal(await cameraMenu.isVisible(), false);
  };
  await cameraButton.click();
  assert.ok(await cameraMenu.getByRole("radio", { name: "Orthographic" }).isChecked());
  const menuBounds = await cameraMenu.boundingBox();
  assert.ok(menuBounds.y + menuBounds.height <= (await cameraButton.boundingBox()).y);
  await page.keyboard.press("Escape");
  assert.equal(await cameraMenu.isVisible(), false);
  assert.ok(await page.getByRole("button", { name: "Finish sketch" }).isVisible());
  await cameraButton.click();
  await page.getByRole("heading", { name: "Timeline" }).click();
  assert.equal(await cameraMenu.isVisible(), false);
  await chooseProjection("Perspective");
  // The center of the cube contains face labels and shading in every orientation.
  const cubeCenter = (view) => page.screenshot({
    clip: { x: view.x + view.width - 76, y: view.y + 44, width: 32, height: 32 },
  });
  const topView = await cubeCenter(bounds); // XY sketching looks straight down on the cube.
  const clickAt = (x, y) => page.mouse.click(bounds.x + x * bounds.width, bounds.y + y * bounds.height);
  await clickAt(0.55, 0.35);
  const drawingDocument = await page.locator('#document-tabs [aria-selected="true"]').getAttribute("data-document");
  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: "New scene", exact: true }).click();
  await page.waitForFunction((id) => document.querySelector('#document-tabs [aria-selected="true"]')?.getAttribute("data-document") !== id && !document.querySelector("#menu-new").disabled, drawingDocument);
  await page.locator(`#document-tabs [data-document="${drawingDocument}"]`).click();
  assert.ok(await page.getByRole("button", { name: "Finish sketch" }).isDisabled(), "Keep the draft waiting for its second corner");
  const toolBounds = await page.locator("#tool-panel").boundingBox();
  // Keep the second corner on the canvas when the tool panel's spacing changes.
  const secondX = Math.min(0.7, (toolBounds.x - bounds.x - 16) / bounds.width);
  await clickAt(secondX, 0.6);
  const width = Number(await page.locator("#width").inputValue());
  const height = Number(await page.locator("#height").inputValue());
  assert.ok(Math.abs(width * height) > 1);
  await page.getByRole("button", { name: "Finish sketch" }).click();
  await page.waitForFunction(() => document.querySelector("#features").children.length === 1);
  await clickAt(0.93, 0.85);
  assert.ok(await page.getByRole("button", { name: "Extrude", exact: true }).isEnabled(), "Extrude can start before selecting a profile");
  // Finishing the sketch retains the drawing camera, so select its drawn center.
  await clickAt((0.55 + secondX) / 2, (0.35 + 0.6) / 2);
  await page.getByRole("button", { name: "Extrude", exact: true }).click();
  await page.locator("#length").fill("25 / 2");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page
    .locator("#js")
    .fill(
      "return (await (await scene.bodies.get((await scene.bodies.all())[0].id)).properties()).volume.value",
    );
  await page.locator("#js").press("Enter");
  await page.waitForFunction(() =>
    Number.isFinite(Number(document.querySelector("#console-output").lastElementChild?.textContent)),
  );
  const volume = Number(await page.locator("#console-output > :last-child").textContent());
  assert.ok(Math.abs(volume - Math.abs(width * height) * 12.5) < 1e-7);
  console.log("Pointer-drawn rectangle", { width, height, volume });

  await chooseProjection("Orthographic");
  await page.getByText("File", { exact: true }).click();
  await page.getByRole("button", { name: "New scene" }).click();
  await page.waitForFunction(() => document.querySelector("#features").children.length === 0);
  const logs = page.locator("#log summary");
  const start = await logs.count();
  await page.locator("#js")
    .fill(`const sketch = await scene.sketches.create(scene.construction.builtin.planes.xy);
    await sketch.primitives.add("circle", {center: [0, 0], diameter: 10});
    await sketch.complete();
    const profile = await sketch.regions.only();
    await core.solid.extrude(profile, {length1: 1});
    for (let length = 2; length <= 10; length++) await core.solid.extrude(profile, {length1: length, mode: "join"});`);
  await page.locator("#js").press("Enter");
  await page.waitForFunction(
    () =>
      document.querySelector("#features").children.length === 11 && !document.querySelector("#js").disabled,
  );
  const commands = (await logs.locator(".command-name").allTextContents()).slice(start);
  assert.equal(commands.filter((method) => method === "solid.extrude").length, 10);
  assert.equal(commands.filter((method) => method === "scene.getProxyFor").length, 1);
  assert.ok(commands.indexOf("scene.getProxyFor") > commands.lastIndexOf("solid.extrude"));

  await page.locator("#home").click();
  await clickAt(0.48, 0.55);
  assert.equal(await page.locator("#status").textContent(), "Face selected");
  await clickAt(0.52, 0.55);
  assert.equal(await page.locator("#status").textContent(), "Face selected");
  // With an isometric camera, the nearest point of the top rim projects just above center.
  const rimHeight = 5 * (Math.sqrt(2 / 3) - 1 / Math.sqrt(3));
  await clickAt(0.5, 0.5 - rimHeight / (Math.sqrt(300) * 1.4));
  assert.equal(await page.locator("#status").textContent(), "Edge selected");
  console.log("Cylinder wall and rim picked; one final proxy for ten commands");

  // The top face remains pickable at the right edge after the canvas resizes.
  for (const width of [1280, 960]) {
    await page.setViewportSize({ width, height: 840 });
    await page.waitForFunction(
      (width) => window.innerWidth === width &&
        document.querySelector("#model-canvas").clientWidth === document.querySelector("#viewport").clientWidth,
      width,
    );
    const view = await canvas.boundingBox();
    const homeView = await cubeCenter(view);
    assert.ok(!homeView.equals(topView), "Home and Top should look different");
    await page.mouse.click(view.x + view.width - 60, view.y + 38);
    assert.ok((await cubeCenter(view)).equals(topView), `Pick top at window width ${width}`);
    await page.getByRole("button", { name: "Fit isometric view" }).click();
    assert.ok((await cubeCenter(view)).equals(homeView), "Home restores the rendered isometric view");
  }

  // In Top view the cylinder's upper rim is 5 mm closer than the orbit target.
  // Perspective enlarges that rim, while the scale at the target stays fixed.
  const view = await canvas.boundingBox();
  const centerX = view.x + view.width / 2, centerY = view.y + view.height / 2;
  const span = Math.sqrt(300) * 1.4;
  const distance = span / (2 * Math.tan(Math.PI / 8));
  const orthoRadius = (view.height * 5) / span;
  const perspectiveRadius = orthoRadius * distance / (distance - 5);
  await chooseProjection("Perspective");
  await page.mouse.click(view.x + view.width - 60, view.y + 38);
  await page.mouse.click(centerX + perspectiveRadius, centerY);
  assert.equal(await page.locator("#status").textContent(), "Edge selected", "Pick the perspective rim");
  await chooseProjection("Orthographic");
  await page.mouse.click(centerX + perspectiveRadius, centerY);
  assert.equal(await page.locator("#status").textContent(), "Ready", "Beyond the orthographic silhouette");
  await page.mouse.click(centerX + orthoRadius, centerY);
  assert.equal(await page.locator("#status").textContent(), "Edge selected", "Pick the orthographic rim");

  // A round trip from a panned and zoomed view must reproduce the same rendering.
  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, -120);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(centerX - 30, centerY + 20, { steps: 5 });
  await page.mouse.up({ button: "right" });
  const modelClip = { x: centerX - 140, y: centerY - 110, width: 280, height: 220 };
  const framed = await page.screenshot({ clip: modelClip });
  await chooseProjection("Perspective");
  assert.ok(!(await page.screenshot({ clip: modelClip })).equals(framed));
  await chooseProjection("Orthographic");
  assert.ok((await page.screenshot({ clip: modelClip })).equals(framed), "Restore orbit center and scale");
  console.log("Camera mode drop-up, perspective sketch, projected rim picks, and round-trip framing passed");
  await testEditorTheme(browser);
  await testSceneBrowser(browser, "http://127.0.0.1:" + server.address().port);
  await testLoadingScreen(browser, "http://127.0.0.1:" + server.address().port);
  await testDocumentTabs(browser, "http://127.0.0.1:" + server.address().port);
  await testExtrudeEditor(browser, "http://127.0.0.1:" + server.address().port);
  await testToolInputs(browser);
} finally {
  await browser?.close();
  server.close();
}
