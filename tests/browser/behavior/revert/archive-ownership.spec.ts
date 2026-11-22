// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test.use({ profile: "revert-native" });
test("revert.saved-branch-switch-releases-excluded-reply-borrows", {
  tag: ["@revert", "@messages", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Archive switch",
  });
  await openSession(state, page, source.id);
  await state.queue(["Original archive reply."]);
  await prompt(page, "Original archive prompt");
  await expect(page.locator(".otk-messages")).toContainText(
    "Original archive reply.",
  );
  await expect(page.locator(`[data-session="${source.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open copy", exact: true }),
  ).toBeVisible();
  // Build an independent legacy archive through public product reads, not by
  // reaching into the current browser codec's private representation.
  const session = await state.product("session.get", { sessionID: source.id });
  const archive = await state.product("history.messages", {
    sessionID: source.id,
    scope: { messageIDs: session.revert!.messageIDs },
  });
  const boundary = archive.items.find((m) => m.role === "user")!;
  const entry = await state.product("history.prompt", {
    sessionID: source.id,
    messageID: boundary.id,
  });
  expect(entry).not.toBeNull();
  await page.evaluate((second) => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith("otk.branch-history.v1/")
    )!;
    localStorage.setItem(
      key.slice(0, key.lastIndexOf("/") + 1) + second.id,
      JSON.stringify(second),
    );
  }, {
    schema: 1,
    id: "other-archive",
    created: Date.now() + 1,
    session: archive.session,
    boundary: boundary.id,
    messages: archive.items.map((m) => ({
      ...m,
      id: m.id + "-other",
      ...(m.role === "assistant" && m.replyTo
        ? { replyTo: m.replyTo + "-other" }
        : {}),
    })),
    prompts: [{ messageID: boundary.id + "-other", entry }],
    turns: archive.turns,
    drafts: [],
    pending: false,
    replaced: false,
    bytes: 0,
  });
  await page.reload();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "Open copy", exact: true })
    .click();
  const saved = page.getByRole("region", {
    name: "Saved earlier branch",
    exact: true,
  });
  await expect(saved).toContainText("Original archive prompt");
  const branches = saved.getByRole("navigation", { name: "Saved branches" })
    .getByRole("button");
  await expect(branches).toHaveCount(2);
  await branches.nth(1).click();
  await expect(saved).toContainText("Original archive prompt");
  await expect(saved.getByRole("button", { name: "Reuse prompt", exact: true }))
    .toHaveCount(1);
  await branches.nth(0).click();
  await expect(saved).toContainText("Original archive prompt");
  expect(errors).toEqual([]);
});

test("revert.blocked-storage-getter-keeps-shell-and-live-history-usable", {
  tag: ["@revert", "@messages", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    })
  );
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Blocked persistence",
  });
  await openSession(state, page, source.id);
  await state.queue(["Live history survives."]);
  await prompt(page, "Keep live history");
  await expect(page.locator(".otk-messages")).toContainText(
    "Live history survives.",
  );
  await expect(page.locator(`[data-session="${source.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  const restore = page.getByRole("button", {
    name: "Restore conversation",
    exact: true,
  });
  await expect(restore).toBeVisible();
  const input = page.locator("textarea[name=prompt]");
  await input.fill("Do not discard my replacement");
  await input.press("Enter");
  await expect(page.locator(".otk-permanence-choice")).toContainText(
    "Sending makes the revert permanent",
  );
  await expect(input).toHaveValue("Do not discard my replacement");
  expect((await state.product("session.get", { sessionID: source.id })).revert)
    .toBeTruthy();
  await restore.click();
  await expect(page.locator(".otk-messages")).toContainText(
    "Live history survives.",
  );
});
