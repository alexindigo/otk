// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test("sessions.sidebar-title-priority-and-flat-timeline", {
  tag: "@sessions",
}, async ({ state, page }) => {
  await state.product("prefs.set", { key: "textSize", value: "125" });
  await state.product("layout.patch", {
    rightCollapsed: false,
    rightWidth: 280,
    rightView: "sessions",
  });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Execution progress and dependency inventory",
  });
  await state.native("/session", "POST", {
    title: "Dependency inventory delegate with a long title",
    parentID: session.id,
  });
  await openSession(state, page, session.id);
  await page.setViewportSize({ width: 900, height: 800 });
  const back = page.getByRole("button", { name: "Back to conversation" });
  await expect(back).toBeVisible();
  await expect(page.locator(`.otk-right-panel [data-session="${session.id}"]`))
    .toBeVisible();
  const right = page.locator(".otk-right-panel");
  const widths = await right.locator(".otk-session-row .otk-sidebar-label")
    .evaluateAll((labels) =>
      labels.flatMap((label) => {
        const width = label.getBoundingClientRect().width;
        if (!width) return [];
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;inline-size:12ch";
        label.append(probe);
        const minimum = probe.getBoundingClientRect().width;
        probe.remove();
        return [{
          text: label.textContent,
          width,
          minimum,
          full: label.scrollWidth <= label.clientWidth,
        }];
      })
    );
  expect(widths.length).toBeGreaterThan(0);
  expect.soft(widths.filter((x) => !x.full && x.width < x.minimum - 1))
    .toEqual([]);

  // D74: return to the conversation to send, then open Timeline in its sheet.
  await back.click();
  await state.queue(["The dependencies are catalogued."]);
  await prompt(page, "Inventory the facade dependencies.");
  await expect(page.locator(".otk-messages")).toContainText(
    "The dependencies are catalogued.",
  );
  await page.locator(".otk-right-rail [data-panel-view=timeline]").click();
  await expect(back).toBeVisible();
  const row = right.locator("[data-timeline-prompt]");
  await expect(row).toHaveCount(1);
  const gap = await row.evaluate((el) => {
    const grid = el.querySelector(".otk-sidebar-row-grid")!;
    const left = grid.getBoundingClientRect().left +
      parseFloat(getComputedStyle(grid).paddingInlineStart);
    return Math.abs(
      el.querySelector(".otk-sidebar-label")!.getBoundingClientRect().left -
        left,
    );
  });
  expect(gap).toBeLessThanOrEqual(1);
});
