// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/evidence.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  prompt,
  settledNativeReply,
  toolScript,
} from "../../pages/transcript.ts";

const prose = "The dependencies are catalogued.";

async function replyWithWork(state: TestState, page: Page, sessionID: string) {
  // D74 / wl-1: step and completion bookkeeping alone do not qualify as work.
  await state.controller.call("writeProjectFiles", {
    lease: state.lease.lease,
    files: { "inventory.txt": "Dependencies catalogued." },
  });
  await toolScript(state, "read", {
    filePath: `${state.directory}/inventory.txt`,
  }, prose);
  await prompt(page, "Inventory the facade dependencies.");
  // The tool-call reply can render before the native continuation ends.
  await settledNativeReply(state, sessionID, prose);
}

test("messages.reply-has-one-work-strip-after-prose", {
  tag: "@messages",
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Work record review",
  });
  await openSession(state, page, session.id);
  await replyWithWork(state, page, session.id);
  const reply = page.locator("[data-role=assistant]").last();
  const text = reply.getByText(prose);
  await expect(text).toBeVisible();
  await expect(page.locator(`[data-session="${session.id}"]`))
    .toHaveAttribute("data-status", "idle");
  const log = reply.locator(".otk-work-strip");
  await expect(log).toHaveCount(1);
  expect((await log.boundingBox())!.y).toBeLessThan(
    (await reply.locator(".otk-message-footer").boundingBox())!.y,
  );
  expect((await log.boundingBox())!.y).toBeGreaterThan(
    (await text.boundingBox())!.y,
  );
});

test("messages.reply-footer-aligns-and-yields-whole-items", {
  tag: "@messages",
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Reply metadata review",
  });
  await openSession(state, page, session.id);
  await replyWithWork(state, page, session.id);
  const reply = page.locator("[data-role=assistant]").last();
  await expect(reply.getByText(prose)).toBeVisible();
  await expect(page.locator(`[data-session="${session.id}"]`))
    .toHaveAttribute("data-status", "idle");
  // D74: close the right sheet before measuring the narrow conversation.
  await state.product("layout.patch", {
    leftCollapsed: false,
    rightCollapsed: true,
  });
  await state.product("prefs.set", { key: "textSize", value: "125" });
  await page.setViewportSize({ width: 720, height: 800 });
  await expect.poll(() =>
    page.locator("html").evaluate((root) =>
      Number(getComputedStyle(root).getPropertyValue("--otk-scale"))
    )
  ).toBe(1.25);
  const footer = reply.locator(".otk-message-footer");
  await expect(reply.locator(".otk-work-strip")).toBeVisible();
  await expect(footer).toBeVisible();
  await expect(footer.locator(".otk-record-completion")).toHaveCount(0);
  const widthAndAlignment = await footer.evaluate((el) => {
    const work = el.closest("article")!.querySelector(".otk-work-strip")!;
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
      difference: Math.abs(
        work.getBoundingClientRect().left - el.getBoundingClientRect().left,
      ),
      clipped,
    };
  });
  expect(widthAndAlignment.difference).toBeLessThanOrEqual(1);
  expect(widthAndAlignment.clipped).toEqual([]);
});
