// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
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
test("attention.question-keyboard-multi-custom-confirm-and-real-rejection", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await seed(state, "Questions");
  await openSession(state, page, session.id);
  await tool(state, "question", { questions });
  await state.queue(["Answers recorded."]);
  await prompt(page, "Ask the interaction questions");
  const tabs = page.locator(".otk-question-dock .otk-tabs-strip [role=tab]"),
    active = page.locator(panel);
  await expect(tabs).toHaveCount(3);
  await expect(page.locator(".otk-question-options button").first()).not
    .toContainText("1.");
  await expect(
    page.locator('.otk-question-actions button[title^="Skip question"]'),
  ).toHaveAttribute("title", /Esc/);
  await expect(page.locator(".otk-question-actions")).not.toContainText("j/k");
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute("name")),
  ).toBeNull();
  await page.keyboard.press("1");
  await expect(page.locator("textarea[name=prompt]")).toHaveValue("");
  await expect(page.locator(".otk-question-dock p").first()).toContainText(
    "Choose the output",
  );
  await expect(page.locator(".otk-prompt")).toBeHidden();
  await tabs.first().click();
  await page.keyboard.press("1");
  await expect(active.locator("button").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator(primary).click();
  await expect(active.locator("p").first()).toHaveText(
    "Choose details (select all that apply)",
  );
  await tabs.nth(1).click();
  await page.keyboard.press("2");
  await expect(active.locator("button").nth(1)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await active.locator("[data-question-row]").last().click();
  await active.locator("textarea[name=question-answer]").fill("Custom detail");
  await page.keyboard.press("Enter");
  await expect(page.locator(primary)).toBeFocused();
  await expect(active.locator("button").nth(1)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("ArrowRight");
  await expect(active.locator("dd").first()).toHaveText("Typed");
  await expect(active.locator("dl")).toContainText("Tools, Custom detail");
  const geometry = await page.locator(".otk-question-dock").evaluate((dock) => {
    const buttons = dock.querySelectorAll(".otk-question-actions button"),
      a = buttons[0].getBoundingClientRect(),
      b = buttons[1].getBoundingClientRect();
    return {
      gap: b.left - a.right,
      right: b.right,
      actions:
        dock.querySelector(".otk-question-actions")!.getBoundingClientRect()
          .right,
      dock: dock.getBoundingClientRect().right,
    };
  });
  expect(geometry.gap).toBeGreaterThanOrEqual(4);
  expect(geometry.right).toBeLessThanOrEqual(geometry.actions);
  expect(geometry.actions).toBeLessThanOrEqual(geometry.dock - .5);
  await tabs.first().click();
  for (const key of ["l", "h", "l", "l"]) await page.keyboard.press(key);
  await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
  await page.locator(primary).click();
  await expect(page.locator(".otk-question-dock")).toHaveCount(0);
  await page.locator("[data-tool=question] .otk-tool-toggle").click();
  await expect(page.locator(".otk-questions")).toContainText("Typed");
  await expect(page.locator(".otk-questions")).toContainText(
    "Tools, Custom detail",
  );
  await reply(page, session.id, "Answers recorded.");
  const history = await state.native<
    {
      parts: {
        tool?: string;
        state?: { metadata?: { answers?: string[][] } };
      }[];
    }[]
  >(`/session/${session.id}/message`);
  expect(
    history.flatMap((m) => m.parts).find((p) => p.tool === "question")?.state
      ?.metadata?.answers,
  ).toEqual([["Typed"], ["Tools", "Custom detail"]]);
  await tool(state, "question", { questions: [questions[0]] });
  await prompt(page, "Ask again, to reject");
  await expect(tabs).toHaveCount(2);
  await tabs.first().click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".otk-question-dock")).toHaveCount(0);
  await page.locator(
    "[data-tool=question][data-tool-status=denied] .otk-tool-toggle",
  ).click();
  await expect(page.locator("[data-tool-status=denied] .otk-questions dd"))
    .toHaveText("Dismissed");
  await expect(page.locator(".otk-prompt-actions")).not.toContainText(
    "esc again",
  );
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
});
