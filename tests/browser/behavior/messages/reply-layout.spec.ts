// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test("messages.reply-has-one-work-log-after-prose", {
  tag: "@messages",
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Work record review",
  });
  await openSession(state, page, session.id);
  await state.queue(["The dependencies are catalogued."]);
  await prompt(page, "Inventory the facade dependencies.");
  const reply = page.locator("[data-role=assistant]").last();
  const text = reply.getByText("The dependencies are catalogued.");
  await expect(text).toBeVisible();
  await expect(page.locator(`[data-session="${session.id}"]`))
    .toHaveAttribute("data-status", "idle");
  const log = reply.locator(".otk-work-log");
  await expect(log).toHaveCount(1);
  expect((await log.boundingBox())!.y).toBeGreaterThan(
    (await text.boundingBox())!.y,
  );
});

test("messages.reply-footer-aligns-and-yields-whole-items", {
  tag: "@messages",
}, async ({ state, page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await state.product("prefs.set", { key: "textSize", value: "125" });
  await state.product("layout.patch", {
    leftCollapsed: false,
    rightCollapsed: false,
  });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Reply metadata review",
  });
  await openSession(state, page, session.id);
  await state.queue(["The dependencies are catalogued."]);
  await prompt(page, "Inventory the facade dependencies.");
  const reply = page.locator("[data-role=assistant]").last();
  await expect(reply.getByText("The dependencies are catalogued."))
    .toBeVisible();
  await expect(page.locator(`[data-session="${session.id}"]`))
    .toHaveAttribute("data-status", "idle");
  const footer = reply.locator(".otk-message-footer");
  await expect(footer).toBeVisible();
  await expect(footer.locator(".otk-record-completion")).toHaveCount(0);
  const widthAndAlignment = await footer.evaluate((el) => {
    const work = el.closest("article")!.querySelector(".otk-work-label")!;
    const details = el.querySelector(".otk-message-details")!;
    const walker = document.createTreeWalker(details, NodeFilter.SHOW_TEXT);
    const limit = details.getBoundingClientRect();
    const clipped = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim() || node.parentElement?.closest("[inert]")) {
        continue;
      }
      const range = document.createRange();
      range.selectNode(node);
      if (
        Array.from(range.getClientRects()).some((box) =>
          box.right > limit.right + 1
        )
      ) {
        clipped.push(node.textContent);
      }
    }
    return {
      difference: Math.abs(work.getBoundingClientRect().left - limit.left),
      clipped,
    };
  });
  expect(widthAndAlignment.difference).toBeLessThanOrEqual(1);
  expect(widthAndAlignment.clipped).toEqual([]);
});
