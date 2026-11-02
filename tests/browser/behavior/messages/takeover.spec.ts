// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
test("messages.takeovers-retain-two-drafts-native-outcomes", {
  tag: ["@messages"],
}, async ({ state, page }) => {
  const a = await state.native<{ id: string }>("/session", "POST", {
      title: "Draft and takeover",
    }),
    other = await state.native<{ id: string }>("/session", "POST", {
      title: "Other draft",
    });
  const capture = await wire(page);
  await openSession(state, page, a.id);
  await page.locator("textarea[name=prompt]").fill(
    "Keep this session's unsent work",
  );
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: {
      name: "bash",
      input: {
        command: "printf takeover-bytes",
        description: "Permission outcome",
      },
    },
  });
  await state.queue(["Permission finished."]);
  await state.native(`/session/${a.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Run a separate backend turn" }],
  });
  await expect(page.locator(".otk-permission-dock")).toBeVisible();
  await expect(page.locator(".otk-composer")).toHaveAttribute(
    "data-takeover",
    "true",
  );
  await expect(page.locator(".otk-permission-dock .otk-surface")).toHaveCSS(
    "border-top-width",
    "1px",
  );
  await expect(page.locator(".otk-prompt")).toBeHidden();
  await expect(page.locator(".otk-prompt button[type=submit]")).toHaveCount(0);
  await openSession(state, page, other.id);
  await page.locator("textarea[name=prompt]").fill("Other session's draft");
  await openSession(state, page, a.id);
  await expect(page.locator(".otk-permission-dock")).toBeVisible();
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Keep this session's unsent work",
  );
  await page.locator(".otk-permission-actions .otk-primary").click();
  await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
  await expect(page.locator(`[data-session="${a.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator(".otk-prompt")).toBeVisible();
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Keep this session's unsent work",
  );
  await page.locator("[data-tool=bash] .otk-tool-toggle").click();
  await expect(page.locator("[data-tool=bash] .otk-tool-output")).toHaveText(
    "takeover-bytes",
  );
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: {
      name: "question",
      input: {
        questions: [{
          header: "Next step",
          question: "Which path?",
          options: [{
            label: "Continue",
            description: "Use the selected path",
          }],
        }],
      },
    },
  });
  await state.queue(["Answer finished."]);
  await state.native(`/session/${a.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Ask a separate backend question" }],
  });
  await expect(page.locator(".otk-question-dock")).toBeVisible();
  await expect(page.locator(".otk-prompt")).toBeHidden();
  await page.locator(".otk-question-options button").click();
  await expect(page.locator(".otk-question-actions .otk-primary")).toHaveText(
    "Answer",
  );
  await page.locator(".otk-question-actions .otk-primary").click();
  await expect(page.locator(".otk-question-dock [role=tab]").last())
    .toHaveAttribute("aria-selected", "true");
  await page.locator(".otk-question-actions .otk-primary").click();
  await expect(page.locator(".otk-question-dock")).toHaveCount(0);
  await expect(page.locator(`[data-session="${a.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Keep this session's unsent work",
  );
  await expect.poll(async () => {
    const raw = await state.native<
      { parts: { state?: { metadata?: { answers?: string[][] } } }[] }[]
    >(`/session/${a.id}/message`);
    return raw.some((row) =>
      row.parts.some((part) =>
        part.state?.metadata?.answers?.[0]?.includes("Continue")
      )
    );
  }).toBe(true);
  expect(capture.sent.some(({ frame }) => frame.method === "permission.reply"))
    .toBe(true);
  expect(capture.sent.some(({ frame }) => frame.method === "question.reply"))
    .toBe(true);
  await openSession(state, page, other.id);
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Other session's draft",
  );
});
