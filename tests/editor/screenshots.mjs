import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

export async function testScreenshots(browser, url) {
  for (const deviceScaleFactor of [1, 2, 3]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 840 }, deviceScaleFactor });
    const page = await context.newPage();
    try {
      page.on("pageerror", error => console.error(error));
      page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
      await page.goto(url);
      await page.addScriptTag({ path: "tests/editor/rectangle.js" });
      await page.evaluate(() => testRectangleEditor());
      await page.screenshot({ path: "/private/tmp/pamatcad-screenshot-before.png" });
      await page.addScriptTag({ path: "tests/editor/screenshots.js" });
      console.log("Screenshot PNG checks", await page.evaluate(() => testScreenshotEditor()));
      const images = await page.evaluate(() => window.screenshotTestImages);
      for (const [mode, image] of Object.entries(images)) {
        await writeFile(`/private/tmp/pamatcad-screenshot-${deviceScaleFactor}x-${mode}.png`, Buffer.from(image.split(",")[1], "base64"));
      }
      const tools = page.locator('#web-menu > details > summary').filter({ hasText: /^Tools$/ });
      await tools.click();
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.locator(':focus').textContent(), "Capture screenshot ›");
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.locator(':focus').textContent(), "Full app");
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.locator(':focus').textContent(), "Viewport with UI");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator('#screenshot-menu-items').isVisible(), false);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator('#tools-menu-items').isVisible(), false);
      await tools.click();
      await page.locator('summary[aria-controls="screenshot-menu-items"]').click();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Viewport without UI", exact: true }).click();
      const file = await download;
      assert.match(file.suggestedFilename(), /^PamatCAD-viewport-.*\.png$/);
      assert.equal(await file.failure(), null);
      assert.equal(await page.locator('#tools-menu-items').isVisible(), false);
      await page.getByText("Help", { exact: true }).click();
      await page.getByRole("button", { name: "About", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "Editor controls" }).count(), 0);
      assert.match(await page.locator('#about-versions').textContent(), /PamatCAD .*OCCT/);
    } catch (error) {
      const images = await page.evaluate(() => window.screenshotTestImages);
      for (const [mode, image] of Object.entries(images ?? {})) {
        await writeFile(`/private/tmp/pamatcad-screenshot-failed-${mode}.png`, Buffer.from(image.split(",")[1], "base64"));
      }
      await page.screenshot({ path: "/private/tmp/pamatcad-screenshot-failed-page.png" });
      throw error;
    } finally { await context.close(); }
  }
}
