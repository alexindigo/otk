// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test("sessions.header-title-and-usage-fit-on-one-line", {
  tag: "@sessions",
}, async ({ state, page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await state.product("prefs.set", { key: "textSize", value: "125" });
  await state.product("layout.patch", {
    leftCollapsed: false,
    rightCollapsed: false,
    leftWidth: 298,
    rightWidth: 298,
  });
  const title = "Facade rollout and transitive dependency inventory";
  const session = await state.native<{ id: string }>("/session", "POST", {
    title,
  });
  await state.product("tasks.create", {
    directory: state.directory,
    name: "Execution",
    sessions: [session.id],
  });
  await openSession(state, page, session.id);
  await state.queue(["The dependencies are catalogued."]);
  await prompt(page, "Inventory the facade dependencies.");
  await expect(page.locator(".otk-messages")).toContainText(
    "The dependencies are catalogued.",
  );
  const header = page.locator(".otk-breadcrumb-row");
  const label = header.locator(`[data-crumb="${session.id}"] .otk-trail-title`);
  const meter = header.locator(".otk-context-meter");
  await expect(meter).toHaveAttribute("data-tokens", /\d+/);
  await expect(label).toBeVisible();
  expect(await label.evaluate((el) => getComputedStyle(el).textOverflow))
    .toBe("ellipsis");
  const rects = await header.evaluate((row) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const rects = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (
        !node.textContent?.trim() ||
        node.parentElement?.closest("[aria-hidden=true]")
      ) continue;
      const range = document.createRange();
      range.selectNode(node);
      const boxes = Array.from(range.getClientRects());
      if (boxes.length) {
        rects.push({ text: node.textContent, lines: boxes.length });
      }
    }
    return rects;
  });
  expect(rects.length).toBeGreaterThan(1);
  expect(rects.filter(({ lines }) => lines !== 1)).toEqual([]);
  expect(await meter.evaluate((el) => getComputedStyle(el).whiteSpace))
    .toBe("nowrap");
});
