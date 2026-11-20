import assert from "node:assert/strict";

export async function testLoadingScreen(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
  const page = await context.newPage();
  let releaseBootstrap;
  const bootstrapGate = new Promise((resolve) => { releaseBootstrap = resolve; });
  let held = false;
  let bootstrapContinuation;
  let failedWasmRequests = 0;
  const entryScript = /\/assets\/index-[^/]+\.js(?:\?.*)?$/;
  try {
    await context.route(entryScript, (route) => {
      if (held) return route.continue();
      held = true;
      bootstrapContinuation = bootstrapGate.then(() => route.continue());
      return bootstrapContinuation;
    });
    await context.route("**/wasm/pamatcad.mjs", (route) => {
      if (failedWasmRequests === 0) {
        failedWasmRequests++;
        return route.abort("failed");
      }
      return route.continue();
    });

    const bootstrapRequested = page.waitForRequest(entryScript);
    // The module request is intentionally held, so DOMContentLoaded cannot finish.
    await page.goto(url, { waitUntil: "commit" });
    await bootstrapRequested;
    await page.waitForFunction(() => {
      const screen = document.querySelector("#loading-screen");
      const main = document.querySelector("main");
      return screen && main && getComputedStyle(screen).display === "grid" &&
        getComputedStyle(main).visibility === "hidden";
    });
    const beforeScript = await page.evaluate(() => {
      const screen = document.querySelector("#loading-screen");
      const probe = document.createElement("span");
      probe.style.color = "var(--foreground)";
      probe.style.backgroundColor = "var(--background)";
      screen.append(probe);
      const expected = getComputedStyle(probe);
      const actual = getComputedStyle(screen);
      const result = {
        themeInjected: !!document.querySelector("#startup-theme"),
        background: actual.backgroundColor,
        expectedBackground: expected.backgroundColor,
        foreground: actual.color,
        expectedForeground: expected.color,
        runtimeThemeApplied: document.documentElement.style.getPropertyValue("--background"),
        canvasCreated: !!document.querySelector("#model-canvas"),
        message: document.querySelector("#loading-message").textContent,
      };
      probe.remove();
      return result;
    });
    assert.ok(beforeScript.themeInjected, "Theme variables should be in the initial HTML");
    assert.notEqual(beforeScript.background, "rgba(0, 0, 0, 0)");
    assert.equal(beforeScript.background, beforeScript.expectedBackground);
    assert.equal(beforeScript.foreground, beforeScript.expectedForeground);
    assert.equal(beforeScript.runtimeThemeApplied, "", "Bootstrap must still be held");
    assert.equal(beforeScript.canvasCreated, false);
    assert.equal(beforeScript.message, "Starting PamatCAD…");
    await page.locator("#loading-screen .loading-logo").evaluate((image) => image.decode());
    assert.equal(await page.locator(".menubar").isVisible(), false);
    assert.equal(await page.locator(".ribbon").isVisible(), false);

    releaseBootstrap();
    await page.locator("#loading-error").waitFor({ state: "visible", timeout: 60000 });
    assert.equal(failedWasmRequests, 1, "Exercise an actual geometry-runtime load failure");
    assert.equal(await page.locator("#loading-message").textContent(), "PamatCAD could not start");
    assert.ok((await page.locator("#loading-error").textContent()).trim());
    assert.equal(await page.locator("#loading-screen").getAttribute("aria-busy"), "false");
    assert.equal(await page.locator("#loading-progress").isVisible(), false);
    assert.equal(await page.locator("main").isVisible(), false);
    assert.equal(await page.locator("#reload-editor").isVisible(), true);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.getByRole("button", { name: "Reload", exact: true }).click(),
    ]);
    await page.waitForFunction(() => document.querySelector("#loading-screen").hidden &&
      !document.body.hasAttribute("data-loading") && !document.querySelector("#new-sketch").disabled,
      undefined, { timeout: 60000 });
    assert.equal(await page.locator("main").isVisible(), true);
    assert.equal(await page.locator('#document-tabs [role="tab"]').count(), 1);
    console.log("Themed first paint, hidden editor, startup failure, and Reload recovery passed");
  } finally {
    releaseBootstrap();
    await bootstrapContinuation?.catch(() => {});
    await context.close();
  }
}
