// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { openWorkLogs } from "../../pages/transcript.ts";
import {
  panel,
  primary,
  prompt,
  questions,
  reply,
  seed,
  tool,
} from "../../pages/attention.ts";

test.use({ profile: "contract-attention-native" });
test(
  "attention.question-transitions-focus-visible-controls-and-preserve-independent-focus",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page }, info) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const session = await seed(state, "Focus ownership");
    await openSession(state, page, session.id);
    await tool(state, "question", { questions });
    await state.queue(["Answers recorded."]);
    // Keyboard submission preserves the original question-arrival focus precondition.
    await page.locator("textarea[name=prompt]").fill(
      "Ask the interaction questions",
    );
    await page.locator("textarea[name=prompt]").press("Enter");
    const active = page.locator(panel), action = page.locator(primary);
    await active.locator("textarea").fill("My own output");
    await page.keyboard.press("Enter");
    await expect(action).toBeFocused();
    await expect(page.locator(".otk-question-dock")).toHaveCount(1);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await info.attach(`question-single-owner-${theme}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
    expect(
      await page.evaluate(() => {
        const card = document.querySelector(".otk-takeover")!
          .getBoundingClientRect();
        return Array.from(document.querySelectorAll("*")).filter((e) => {
          const s = getComputedStyle(e), r = e.getBoundingClientRect();
          return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 &&
            (r.width > card.width + 1 || r.height > card.height + 1);
        }).map((e) => e.className);
      }),
    ).toEqual([]);
    expect(
      await action.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !e.closest("[inert],[hidden]") &&
          e.matches("button,input,textarea,a[href]");
      }),
    ).toBe(true);
    await action.click();
    await expect(active.locator("button").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(active.locator("button").nth(1)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(active.locator("textarea")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(action).toBeFocused();
    await active.locator("textarea").fill("My own details");
    await page.keyboard.press("Escape");
    await expect(action).toBeFocused();
    await action.click();
    const tabs = page.locator(".otk-question-dock .otk-tabs-strip button");
    await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
    await expect(action).toBeFocused();
    const collapse = page.locator(".otk-takeover-collapse");
    await collapse.click();
    await expect(collapse).toBeFocused();
    await expect(page.locator(".otk-takeover")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await collapse.click();
    await expect(action).toBeFocused();
    await tabs.first().click();
    await expect(active.locator("button").first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(active.locator("button").first()).toBeFocused();
    await page.locator(".otk-question-submit").click();
    await expect(page.locator(".otk-question-dock")).toHaveCount(0);
    await expect(page.locator("textarea[name=prompt]")).toBeFocused();
    await reply(page, session.id, "Answers recorded.");
    await openWorkLogs(page);
    await page.locator("[data-tool=question] .otk-tool-toggle").click();
    await expect(page.locator(".otk-questions")).toContainText(
      "My own details",
    );
    await page.keyboard.press("Tab");
    for (
      const selector of [
        ".otk-user-bubble",
        ".otk-message-agent",
        ".otk-last-output-time",
      ]
    ) {
      await page.locator(selector).first().focus();
      await expect(page.locator(selector).first()).toHaveCSS(
        "outline-style",
        "solid",
      );
    }
    await tool(state, "question", { questions: [questions[0]] });
    await prompt(page, "Ask to skip");
    await expect(page.locator(".otk-question-dock")).toBeVisible();
    await page.locator(".otk-question-actions button").nth(1).click();
    await expect(page.locator(".otk-question-dock")).toHaveCount(0);
    await expect(page.locator("textarea[name=prompt]")).toBeFocused();
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
    await tool(state, "question", { questions: [questions[0]] });
    await prompt(page, "Ask while I use the sidebar");
    await expect(page.locator(".otk-question-dock")).toBeVisible();
    const search = page.locator('.otk-project-sessions input[type="search"]');
    await search.click();
    const [pending] = await state.product("question.list", {
      sessionID: session.id,
    });
    await state.product("question.reject", { requestID: pending.id });
    await expect(page.locator(".otk-question-dock")).toHaveCount(0);
    await expect(search).toBeFocused();
  },
);
