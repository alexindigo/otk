// SPDX-License-Identifier: LGPL-3.0-only
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  prompt,
  revealAcquired,
  runNativeTool,
} from "../../pages/transcript.ts";
import type { TestState } from "../../fixtures/test-state.ts";

test.use({ profile: "revert-native" });
async function palette(page: Page, command: string) {
  await page.keyboard.press("Control+k");
  await page.locator(`[data-command="${command}"]`).click();
  await expect(page.getByRole("dialog", { name: "Commands", exact: true })).not
    .toBeVisible();
}
async function reply(
  state: TestState,
  page: Page,
  id: string,
  text: string,
  result: string,
) {
  const before =
    (await state.observe<{ requests: unknown[] }>()).requests.length;
  await state.queue([result]);
  await prompt(page, text);
  await expect.poll(async () =>
    (await state.observe<{ requests: unknown[] }>()).requests.length
  ).toBeGreaterThan(before);
  await expect(page.locator(".otk-messages")).toContainText(result);
  await expect(page.locator(`[data-session="${id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
}
async function action(
  state: TestState,
  kind: "hold" | "release" | "freeze" | "thaw",
  path?: "revert" | "unrevert",
) {
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: kind,
    ...(path ? { target: path } : {}),
  });
}

test("revert.shared-directory-native-rollback-restore-other-edit", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const a = await state.native<{ id: string }>("/session", "POST", {
    title: "Session A",
  });
  const b = await state.native<{ id: string }>("/session", "POST", {
    title: "Session B",
  });
  const path = state.directory + "/shared.txt";
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await openSession(state, page, a.id);
  await runNativeTool(state, page, a.id, "write", {
    filePath: path,
    content: "A\n",
  });
  await openSession(state, page, b.id);
  await runNativeTool(state, page, b.id, "edit", {
    filePath: path,
    oldString: "A",
    newString: "B",
  });
  const transcript = await state.native(`/session/${b.id}/message`);
  expect(await readFile(path, "utf8")).toBe("B\n");
  await openSession(state, page, a.id);
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "1 prompt rolled back",
  );
  await expect(readFile(path, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await state.native(`/session/${b.id}/message`)).toEqual(transcript);
  await page.locator(".otk-rollback-disclosure").click();
  await page.locator(".otk-rollback-footer button").click();
  await expect(page.locator(".otk-rolled-back-strip")).toHaveCount(0);
  expect(await readFile(path, "utf8")).toBe("B\n");
  expect(await state.native(`/session/${b.id}/message`)).toEqual(transcript);
  expect(dialogs).toEqual([]);
});

test("revert.files-conversation-copy-reload-restore-and-commit", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page, context }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await state.controller.call("writeProjectFiles", {
    lease: state.lease.lease,
    files: { "revert.txt": "before\n" },
  });
  const s = await state.native<{ id: string }>("/session", "POST", {
    title: "Rollback review",
  });
  await openSession(state, page, s.id);
  await runNativeTool(state, page, s.id, "edit", {
    filePath: state.directory + "/revert.txt",
    oldString: "before",
    newString: "after",
  });
  await reply(state, page, s.id, "Explain the file change", "Second reply.");
  const messages = await state.native<{ info: { id: string; role: string } }[]>(
    `/session/${s.id}/message`,
  );
  const id = messages.find((m) => m.info.role === "user")!.info.id;
  const bubble = `[data-message="${id}"] .otk-user-bubble`;
  const revert =
    `[data-message="${id}"] [data-message-command="prompt.revert"]`;
  await revealAcquired(page, bubble);
  await page.locator(bubble).focus();
  await page.locator(revert).click();
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "2 prompts rolled back",
  );
  await expect(page.locator("[data-message]")).toHaveCount(0);
  expect(await readFile(state.directory + "/revert.txt", "utf8")).toBe(
    "before\n",
  );
  await page.locator(".otk-rollback-disclosure").click();
  await expect(page.locator(".otk-rollback-prompt")).toHaveCount(2);
  await expect(page.locator(".otk-rollback-details")).toContainText(
    "revert.txt",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: state.url,
  });
  await page.getByRole("button", {
    name: "Copy rolled-back prompt",
    exact: true,
  }).first().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("Run edit");
  await page.reload();
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "2 prompts rolled back",
  );
  await expect(page.locator(".otk-rollback-disclosure")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.locator(".otk-rollback-disclosure").click();
  await page.locator(".otk-rollback-footer button").click();
  await expect(page.locator(".otk-rolled-back-strip")).toHaveCount(0);
  await expect(page.locator("[data-role=user]")).toHaveCount(2);
  expect(await readFile(state.directory + "/revert.txt", "utf8")).toBe(
    "after\n",
  );
  await revealAcquired(page, bubble);
  await page.locator(bubble).focus();
  await page.locator(revert).click();
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "2 prompts rolled back",
  );
  await reply(state, page, s.id, "Take a new direction", "New direction.");
  await expect(page.locator(".otk-rolled-back-strip")).toHaveCount(0);
  expect(
    (await state.native<{ info: { role: string } }[]>(
      `/session/${s.id}/message`,
    )).filter((m) => m.info.role === "user"),
  ).toHaveLength(1);
  expect(dialogs).toEqual([]);
});

test("revert.pending-error-owned-feedback-retry", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const s = await state.native<{ id: string }>("/session", "POST", {
    title: "Rollback feedback",
  });
  await state.native(`/session/${s.id}/message`, "POST", {
    noReply: true,
    parts: [{ type: "text", text: "A prompt to roll back" }],
  });
  await openSession(state, page, s.id);
  await action(state, "hold", "revert");
  await action(state, "freeze");
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  await expect(page.locator(".otk-composer-notice [role=status]"))
    .toContainText("Rolling back");
  await action(state, "release");
  await expect(page.locator(".otk-composer-notice [role=alert]")).toHaveCount(
    1,
  );
  await expect(page.locator(".otk-composer-notice [role=alert]")).toContainText(
    "This session is working",
  );
  await expect(page.locator(".otk-rollback-status")).toHaveCount(0);
  await expect(page.locator("[data-role=user]")).toHaveCount(1);
  await action(state, "thaw");
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "1 prompt rolled back",
  );
  await expect(page.locator(".otk-composer-notice [role=alert]")).toHaveCount(
    0,
  );
});

test("revert.undo-redo-aliases-draft-guard-and-busy-interruption", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const s = await state.native<{ id: string }>("/session", "POST", {
    title: "Undo review",
  });
  await openSession(state, page, s.id);
  for (const text of ["First prompt", "Second prompt"]) {
    await reply(state, page, s.id, text, `Reply to ${text}.`);
  }
  const input = page.locator("textarea[name=prompt]");
  await prompt(page, "/undo");
  await expect(input).toHaveValue("Second prompt");
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "1 prompt rolled back",
  );
  await page.keyboard.press("Control+k");
  await expect(page.locator('[data-command="session.undo"]')).toBeVisible();
  await expect(page.locator('[data-command="session.redo"]')).toBeVisible();
  await expect(page.locator(".otk-palette-list button:disabled")).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await prompt(page, "/undo");
  await expect(input).toHaveValue("First prompt");
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "2 prompts rolled back",
  );
  await action(state, "hold", "unrevert");
  await prompt(page, "/redo");
  await expect(page.locator(".otk-composer-notice [role=status]"))
    .toContainText("Restoring");
  await action(state, "release");
  await expect(input).toHaveValue("");
  await expect(page.locator(".otk-rolled-back-strip")).toHaveCount(0);
  await expect(page.locator("[data-role=user]")).toHaveCount(2);
  await input.fill("Keep this edited draft");
  await palette(page, "session.undo");
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "1 prompt rolled back",
  );
  await expect(input).toHaveValue("Keep this edited draft");
  await palette(page, "session.redo");
  await expect(page.locator(".otk-rolled-back-strip")).toHaveCount(0);
  await expect(input).toHaveValue("Keep this edited draft");
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: Array(30).fill("Still working. "),
    delay: 1000,
  });
  await prompt(page, "Interrupt this prompt");
  await expect(page.locator(`[data-session="${s.id}"]`)).toHaveAttribute(
    "data-status",
    "busy",
  );
  // Native busy admission precedes the provider request. Exercise interruption
  // of the scripted reply, rather than cancellation before that reply is owned.
  await expect.poll(async () =>
    (await state.observe<{ requests: unknown[] }>()).requests.some((request) =>
      JSON.stringify(request).includes("Interrupt this prompt")
    )
  ).toBe(true);
  const before =
    (await state.observe<{ transport: { mutations: string[] } }>()).transport
      .mutations.length;
  await palette(page, "session.undo");
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "1 prompt rolled back",
  );
  await expect(input).toHaveValue("Interrupt this prompt");
  expect(
    (await state.observe<{ transport: { mutations: string[] } }>()).transport
      .mutations.slice(before),
  ).toEqual(["abort", "revert"]);
  await palette(page, "session.redo");
  await expect(page.locator(".otk-rolled-back-strip")).toHaveCount(0);
  await expect(input).toHaveValue("");
  expect(dialogs).toEqual([]);
});

test("revert.controls-absent-while-working-and-in-readonly-helper", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const root = await state.native<{ id: string; nativeID: string }>(
    "/session",
    "POST",
    { title: "Root" },
  );
  const child = await state.native<{ id: string }>("/session", "POST", {
    title: "Helper",
    parentID: root.nativeID,
  });
  await state.native(`/session/${child.id}/message`, "POST", {
    noReply: true,
    parts: [{ type: "text", text: "Helper prompt" }],
  });
  await openSession(state, page, root.id);
  const held = await state.queue(["Work in progress."], "held");
  await prompt(page, "Keep working");
  await expect(page.locator(`[data-session="${root.id}"]`)).toHaveAttribute(
    "data-status",
    "busy",
  );
  await expect(page.locator('[data-message-command="prompt.revert"]'))
    .toHaveCount(0);
  await state.release(held.gate);
  await expect(page.locator(".otk-messages")).toContainText(
    "Work in progress.",
  );
  await expect(page.locator(`[data-session="${root.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator('[data-message-command="prompt.revert"]'))
    .toBeAttached();
  await page.locator(`[data-session="${child.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${root.id}/${child.id}$`));
  await expect(page.getByRole("region", { name: "Transcript", exact: true }))
    .toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".otk-messages")).toContainText("Helper prompt");
  await expect(page.locator('[data-message-command="prompt.revert"]'))
    .toHaveCount(0);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Commands", exact: true }))
    .toBeVisible();
  for (const command of ["session.undo", "session.redo", "session.compact"]) {
    await expect(page.locator(`[data-command="${command}"]`)).toHaveCount(0);
  }
  await expect(page.locator(".otk-palette-list button:disabled")).toHaveCount(
    0,
  );
});
