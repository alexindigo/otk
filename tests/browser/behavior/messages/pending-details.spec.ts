// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt, reply, seed, tool } from "../../pages/attention.ts";

test.use({ profile: "contract-attention-native" });
test("messages.pending-preview-and-ready-question-copy", {
  tag: ["@messages", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  const session = await seed(state, "Canonical pending details");
  await openSession(state, page, session.id);
  await tool(state, "read", { filePath: `${state.directory}/README.md` });
  await tool(state, "edit", {
    filePath: `${state.directory}/README.md`,
    oldString: "# OTK fixture",
    newString: "# Changed fixture",
  });
  await state.queue(["Edit completed."]);
  await prompt(page, "Preview the edit");
  const dock = page.locator(".otk-permission-dock");
  await dock.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(dock).toContainText("+1 / \u22121");
  const edit = page.locator("[data-tool=edit]");
  await expect(edit.locator(".otk-tool-add")).toHaveText("+1");
  await expect(edit.locator(".otk-tool-del")).toHaveText("\u22121");
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await info.attach(`messages-pending-counts-${theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
  await dock.getByRole("button", { name: "Allow once", exact: true }).click();
  await reply(page, session.id, "Edit completed.");
  await expect(edit.locator(".otk-tool-add")).toHaveText("+1");
  await expect(edit.locator(".otk-tool-del")).toHaveText("\u22121");
  await tool(state, "question", {
    questions: [{
      header: "Next step",
      question: "Which path?",
      options: [{ label: "Continue", description: "Use this path" }],
    }],
  });
  await state.queue(["Answer completed."]);
  await prompt(page, "Ask the next step");
  const question = page.locator(".otk-question-dock");
  await expect(question).toBeVisible();
  await expect(
    page.locator(".otk-progress-status").filter({
      hasText: /Loading messages|ready/i,
    }),
  ).toHaveCount(0);
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await info.attach(`messages-question-ready-${theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
  await page.locator(".otk-question-options button").click();
  await page.locator(".otk-question-actions .otk-primary").click();
  await expect(question.locator("[role=tab]").last()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.locator(".otk-question-actions .otk-primary").click();
  await reply(page, session.id, "Answer completed.");
  const other = await seed(state, "After question settlement");
  await openSession(state, page, other.id);
});
