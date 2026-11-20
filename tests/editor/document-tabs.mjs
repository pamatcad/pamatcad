import assert from "node:assert/strict";

export async function testDocumentTabs(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const tab = (id) => page.locator(`#document-tabs [role="tab"][data-document="${id}"]`);
  const order = () => page.locator('#document-tabs [role="tab"]').evaluateAll((tabs) => tabs.map((tab) => tab.dataset.document));
  const active = () => page.locator('#document-tabs [aria-selected="true"]').getAttribute("data-document");
  const create = async () => {
    const count = (await order()).length;
    await page.getByText("File", { exact: true }).click();
    await page.getByRole("button", { name: "New scene", exact: true }).click();
    await page.waitForFunction((count) => document.querySelectorAll('#document-tabs [role="tab"]').length === count + 1 && !document.querySelector("#menu-new").disabled, count);
    return active();
  };
  const beginDrag = async (id, x, y) => {
    const rect = await tab(id).boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 12 });
  };
  const move = async (id, neighbor, before) => {
    const target = await tab(neighbor).locator("..").boundingBox();
    await beginDrag(id, target.x + (before ? 2 : target.width - 2), target.y + target.height / 2);
    await page.mouse.up();
  };
  try {
    await page.goto(url);
    await page.addScriptTag({ path: "tests/editor/rectangle.js" });
    await page.evaluate(() => testRectangleEditor());
    const first = await active();
    const second = await create();
    const third = await create();
    await page.locator("#new-sketch").click();
    await page.locator("#width").fill("23");
    await page.locator("#height").fill("9");

    await move(first, third, false);
    assert.deepEqual(await order(), [second, third, first]);
    assert.equal(await active(), third, "Dragging an inactive tab must not activate it");
    assert.equal(await page.locator("#width").inputValue(), "23");
    assert.equal(await page.locator("#height").inputValue(), "9");
    assert.equal(await page.locator("#features li").count(), 0, "Reordering must not commit a draft");

    await move(third, second, true);
    assert.deepEqual(await order(), [third, second, first]);
    assert.equal(await active(), third, "Dragging the active tab preserves its document");

    const last = await tab(first).boundingBox();
    await beginDrag(third, last.x + last.width, last.y + last.height / 2);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.deepEqual(await order(), [third, second, first], "Escape cancels the reorder");
    assert.equal(await page.locator("#width").inputValue(), "23", "Escape during drag must not cancel the sketch");
    await beginDrag(third, last.x, last.y + last.height + 40);
    await page.mouse.up();
    assert.deepEqual(await order(), [third, second, first], "Dropping outside the bar cancels the reorder");
    assert.equal(await active(), third);

    const pending = await tab(third).boundingBox();
    await page.mouse.move(pending.x + pending.width / 2, pending.y + pending.height / 2);
    await page.mouse.down();
    await page.mouse.move(pending.x + pending.width / 2, pending.y + pending.height + 40);
    await page.mouse.up();
    await page.mouse.move(last.x, last.y + last.height / 2);
    assert.equal(await page.locator("#document-tabs").evaluate((node) => node.classList.contains("dragging-tabs")), false,
      "Releasing outside before a drag starts must not leave a drag armed");
    assert.deepEqual(await order(), [third, second, first]);

    // A normal click, including a small pointer movement, still activates a tab.
    const secondRect = await tab(second).boundingBox();
    await page.mouse.move(secondRect.x + secondRect.width / 2, secondRect.y + secondRect.height / 2);
    await page.mouse.down();
    await page.mouse.move(secondRect.x + secondRect.width / 2 + 2, secondRect.y + secondRect.height / 2);
    await page.mouse.up();
    assert.equal(await active(), second);
    await tab(third).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await active(), second, "Keyboard traversal follows reordered tabs");
    assert.equal(await tab(second).evaluate((node) => node === document.activeElement), true);

    await tab(second).locator("..").getByRole("button", { name: "Close Untitled 2", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#document-tabs [role="tab"]').length === 2 && !document.querySelector("#menu-new").disabled);
    assert.equal(await active(), first, "Closing selects the neighbor in the reordered document list");
    assert.deepEqual(await order(), [third, first]);
    assert.equal(await page.locator("#features li").count(), 2);
    await page.locator("#js").fill("return (await (await scene.bodies.get((await scene.bodies.all())[0].id)).properties()).volume.value");
    await page.locator("#js").press("Enter");
    await page.waitForFunction(() => document.querySelector("#console-output").lastElementChild?.textContent === "1500" && !document.querySelector("#js").disabled);
    await tab(third).click();
    assert.equal(await page.locator("#width").inputValue(), "23", "Draft survives reorder, switching and closing another tab");

    await page.setViewportSize({ width: 800, height: 840 });
    for (let index = 0; index < 10; index++) await create();
    const beforeScroll = await order();
    const moved = beforeScroll.at(-1);
    const strip = await page.locator("#document-tabs").boundingBox();
    await beginDrag(moved, strip.x + 1, strip.y + strip.height / 2);
    await page.waitForFunction(() => document.querySelector("#document-tabs").scrollLeft <= 1);
    await page.mouse.up();
    assert.deepEqual(await order(), [moved, ...beforeScroll.slice(0, -1)], "Scroll left while dragging to the beginning");
    assert.equal(await active(), moved);

    await beginDrag(moved, strip.x + strip.width - 1, strip.y + strip.height / 2);
    await page.waitForFunction(() => {
      const tabs = document.querySelector("#document-tabs");
      return tabs.scrollWidth - tabs.clientWidth - tabs.scrollLeft <= 1;
    });
    await page.mouse.up();
    assert.deepEqual(await order(), beforeScroll, "Scroll right while dragging to the end");
    assert.equal(await active(), moved);
    assert.deepEqual(errors, []);
    console.log("Tab dragging, draft preservation, cancellation, reordered navigation/closing and edge scrolling passed");
  } finally {
    await context.close();
  }
}
