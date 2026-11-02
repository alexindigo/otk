// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test("messages.streaming-grammar-unknown-language", {
  tag: ["@messages", "@contracts"],
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Highlighting",
  });
  await openSession(state, page, session.id);
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [
      "```ts\nconst finished: number = 1;\n",
      ...Array.from(
        { length: 20 },
        (_, i) => `const row${i}: number = ${i};\n`,
      ),
      "```\n",
    ],
    delay: 100,
  });
  await prompt(page, "Stream TypeScript");
  await expect.poll(() => page.locator(".otk-token").count())
    .toBeGreaterThanOrEqual(8);
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "busy",
  );
  const colours = () =>
    page.locator(".otk-code code .otk-token").evaluateAll((tokens) =>
      tokens.slice(0, 8).map((token) => ({
        text: token.textContent,
        color: getComputedStyle(token).color,
      }))
    );
  const prefix = await colours();
  expect(new Set(prefix.map((token) => token.color)).size).toBeGreaterThan(1);
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator(".otk-code code")).toContainText("const row19");
  await expect(page.locator(".otk-token").filter({ hasText: /^row19$/ }))
    .toHaveCount(1);
  expect(await colours()).toEqual(prefix);
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [
      "```ts\nconst seed: number = 0;\n/* opened\n",
      "comment continues\n",
      "*/\nconst afterSeed: number = 1;\n",
      "```\n",
    ],
    delay: 180,
  });
  await prompt(page, "Preserve seeded multiline grammar state");
  const comment = page.locator(".otk-token").filter({
    hasText: "comment continues",
  });
  await expect(comment).toHaveCount(1);
  const commentColor = await comment.evaluate((element) =>
    getComputedStyle(element).color
  );
  expect(commentColor).toBe(
    await page.evaluate(() => {
      const sample = document.createElement("span");
      sample.style.color = "var(--otk-code-comment)";
      document.body.append(sample);
      const color = getComputedStyle(sample).color;
      sample.remove();
      return color;
    }),
  );
  await expect(comment).toHaveAttribute("style", /--otk-syntax-token-comment/);
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator(".otk-token").filter({ hasText: /^afterSeed$/ }))
    .toHaveCount(1);
  expect(await comment.evaluate((element) => getComputedStyle(element).color))
    .toBe(commentColor);
  await state.queue(["```otk-unknown-language\nplain unknown syntax\n```\n"]);
  await prompt(page, "Unknown language");
  await expect(page.locator("[data-language=otk-unknown-language] code"))
    .toHaveJSProperty("textContent", "plain unknown syntax");
  await expect(page.locator("[data-language=otk-unknown-language] .otk-token"))
    .toHaveCount(0);
});
