// SPDX-License-Identifier: LGPL-3.0-only
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import type { PublicFailure } from "@otk/protocol";
import { pick, rightClick } from "../../pages/menus.ts";
import {
  expectNoConversation,
  expectRestoredPrompts,
  prompt,
  revealAcquired,
  runNativeTool,
} from "../../pages/transcript.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { chips, messages, pendingChips, upload } from "../../pages/composer.ts";

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

async function revertFiles(state: TestState, page: Page, bubble: string) {
  await page.locator(bubble).focus();
  if (state.controller.info!.version.startsWith("2.")) {
    // V2's default is messages-only; file rollback is its explicit native action.
    await rightClick(page, bubble);
    await pick(page, "Revert code changes");
  } else {
    await page.locator(bubble).locator("..").locator(
      '[data-message-command="prompt.revert"]',
    ).click();
  }
}

test("revert.restore-visible-with-full-draft-and-exact-transcript", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Restore conversation",
  });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await openSession(state, page, source.id);
  await reply(state, page, source.id, "Original prompt", "Original reply.");
  const before = await messages(state, source.id);
  const transcript = await page.locator(".otk-messages .otk-text")
    .allTextContents();
  const input = page.locator("textarea[name=prompt]");
  await input.pressSequentially("@READ");
  await expect(page.locator(".otk-autocomplete")).toContainText("README.md");
  await input.press("Enter");
  await input.pressSequentially(" Unsent draft");
  await upload(page, [{
    name: "draft.txt",
    bytes: btoa("Exact unsent bytes"),
  }]);
  await expect(chips(page)).toHaveCount(2);
  await expect(pendingChips(page)).toHaveCount(0);
  const draft = await input.inputValue();
  const attachments = await chips(page).allTextContents();
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  const strip = page.locator(".otk-rolled-back-strip");
  const restore = strip.getByRole("button", {
    name: "Restore conversation",
    exact: true,
  });
  await expect(restore).toBeVisible();
  await expect(page.locator(".otk-rollback-disclosure")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.locator(".otk-rollback-details")).toHaveCount(0);
  await expect(input).toHaveValue(draft);
  for (
    const [name, id] of [["dark", "otk-dark"], ["linen", "otk-light"], [
      "stone",
      "otk-light-stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: id });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", id);
    await expect(restore).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`rv1-restore-${name}.png`),
      fullPage: true,
    });
  }
  await restore.click();
  await expect(strip).toHaveCount(0);
  await expect(input).toHaveValue(draft);
  expect(await chips(page).allTextContents()).toEqual(attachments);
  await expect.poll(() =>
    page.locator(".otk-messages .otk-text").allTextContents()
  ).toEqual(transcript);
  const originalIDs = new Set(before.map((row) => row.info.id));
  expect(
    (await messages(state, source.id)).filter((row) =>
      originalIDs.has(row.info.id)
    ),
  ).toEqual(before);
});

test("revert.undo-restore-after-navigation-and-command-surfaces", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Accidental undo",
  });
  const other = await state.native<{ id: string }>("/session", "POST", {
    title: "Other session",
  });
  await openSession(state, page, source.id);
  await reply(
    state,
    page,
    source.id,
    "Undo this prompt",
    "Bring back this reply.",
  );
  await palette(page, "session.undo");
  const input = page.locator("textarea[name=prompt]");
  await expect(input).toHaveValue("Undo this prompt");
  await openSession(state, page, other.id);
  await openSession(state, page, source.id);
  await page.getByRole("button", { name: "Restore conversation", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await expect(page.locator(".otk-messages")).toContainText(
    "Bring back this reply.",
  );
  await palette(page, "session.undo");
  await page.keyboard.press("Control+k");
  await expect(page.locator('[data-command="session.restore"]')).toContainText(
    "Restore conversation",
  );
  await page.keyboard.press("Escape");
  await input.fill("/rest");
  await expect(page.locator(".otk-autocomplete")).toContainText("restore");
  await input.press("Enter");
  await expect(page.locator(".otk-rolled-back-strip")).toHaveCount(0);
  await expect(input).toHaveValue("");
  await expect(page.locator(".otk-messages")).toContainText(
    "Bring back this reply.",
  );
});

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
  await revertFiles(state, page, ".otk-user-bubble");
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

test("revert.restore-settles-origin-draft-after-leaving-during-native-clear", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Background restore",
  });
  const other = await state.native<{ id: string }>("/session", "POST", {
    title: "Other composer",
  });
  await openSession(state, page, source.id);
  await reply(state, page, source.id, "Undo then navigate", "Restored reply.");
  await palette(page, "session.undo");
  const input = page.locator("textarea[name=prompt]");
  await expect(input).toHaveValue("Undo then navigate");
  await action(state, "hold", "unrevert");
  await page.getByRole("button", { name: "Restore conversation", exact: true })
    .click();
  await expect(page.locator(".otk-composer-notice [role=status]"))
    .toContainText("Restoring");
  await openSession(state, page, other.id);
  await input.fill("Other draft stays");
  await action(state, "release");
  await expect.poll(async () =>
    (await state.product("session.get", { sessionID: source.id })).revert
  ).toBeFalsy();
  await expect(input).toHaveValue("Other draft stays");
  await openSession(state, page, source.id);
  await expect(input).toHaveValue("");
  await expect(page.locator(".otk-messages")).toContainText("Restored reply.");
});

test("revert.restore-settles-origin-draft-after-cancelled-reconciliation", {
  tag: ["@revert", "@isolated", "@transport"],
}, async ({ isolatedState: state, page }, info) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Reconciliation cancellation",
  });
  const other = await state.native<{ id: string }>("/session", "POST", {
    title: "Other composer",
  });
  let restoreID: string | undefined, restoreKey: string | undefined;
  const frames = await wire(page, (frame) => {
    if (frame.t === "request" && frame.method === "session.restore") {
      restoreID = frame.params?.sessionID;
      restoreKey = frame.ref?.key;
    }
    return frame;
  });
  await openSession(state, page, source.id);
  await reply(
    state,
    page,
    source.id,
    "Restore after reconciliation cancellation",
    "Native conversation restored.",
  );
  const input = page.locator("textarea[name=prompt]");
  await expect(input).toHaveValue("");
  await palette(page, "session.undo");
  await expect(input).toHaveValue("Restore after reconciliation cancellation");
  frames.hold((frame, request) => {
    if (!restoreID) return false;
    if (frame.t === "content") return frame.sessionID === restoreID;
    if (frame.t === "transcript.invalidated") {
      return !frame.sessionID || frame.sessionID === restoreID;
    }
    return frame.t === "request.result" &&
      request?.method === "session.messages" &&
      request.params?.sessionID === restoreID;
  });
  try {
    await page.getByRole("button", {
      name: "Restore conversation",
      exact: true,
    }).click();
    await expect.poll(() =>
      !!restoreKey && frames.received.some((frame) =>
        frame.t === "request.result" && frame.ref?.key === restoreKey &&
        (frame.outcome as { ok?: boolean } | undefined)?.ok === true
      ) && frames.sent.some(({ frame }) =>
        frame.t === "request.received" && Array.isArray(frame.refs) &&
        frame.refs.some((value) =>
          value.ref?.key === restoreKey
        )
      )
    ).toBe(true);
    await expect.poll(() => frames.held.length).toBeGreaterThan(0);
    await expect(
      page.getByRole("complementary", { name: "Rolled-back prompts" })
        .getByRole("status"),
    ).toContainText("Restoring");
    await info.attach("confirmed-clear-before-view-cancellation", {
      body: JSON.stringify({
        restoreID,
        restoreKey,
        sent: frames.sent,
        received: frames.received,
        held: frames.held,
      }),
      contentType: "application/json",
    });
    await openSession(state, page, other.id);
    await input.fill("Other draft stays");
    frames.release();
    await expect(input).toHaveValue("Other draft stays");
    await openSession(state, page, source.id);
    await expect(page.locator(".otk-rolled-back-strip")).toHaveCount(0);
    await expect(input).toHaveValue("");
    await expect(page.locator(".otk-messages")).toContainText(
      "Native conversation restored.",
    );
  } finally {
    frames.release();
  }
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
  await revealAcquired(page, bubble);
  await revertFiles(state, page, bubble);
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "2 prompts rolled back",
  );
  // Decisions 1/20: native controls before the first prompt stay visible.
  await expectNoConversation(state, page);
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
  await expectRestoredPrompts(state, page, s.id, 2);
  expect(await readFile(state.directory + "/revert.txt", "utf8")).toBe(
    "after\n",
  );
  await revealAcquired(page, bubble);
  await revertFiles(state, page, bubble);
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
  const traffic = await wire(page);
  const s = await state.native<{ id: string }>("/session", "POST", {
    title: "Rollback feedback",
    messages: [{ parts: [{ type: "text", text: "A prompt to roll back" }] }],
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
  const request = traffic.sent.filter((item) =>
    item.frame.method === "session.revert"
  ).at(-1)!.frame;
  const result = traffic.received.filter((frame) =>
    frame.t === "request.result" && frame.ref?.key === request.ref!.key
  ).at(-1)!.outcome as { ok: boolean; error: PublicFailure };
  expect(result.ok).toBe(false);
  expect(result.error.facts?.reason).toBeTruthy();
  expect(result.error.facts?.status).toBe(409);
  const failure = page.locator(".otk-composer-notice [role=alert]");
  // FP1 retains the producer's public reason instead of per-code fixed copy.
  await expect(failure).toContainText(result.error.facts!.reason!);
  await expect(failure).toContainText("HTTP 409");
  await expect(
    failure.getByRole("link", { name: "Rollback feedback", exact: true }),
  )
    .toHaveAttribute("href", `#/local/${s.id}`);
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
  // Redo restores both prompts. Visible native idle records (decision 1, plus
  // the one native adds on unrevert) can move the first out of the mounted
  // window, so prove both from acquired messages and reveal each bubble.
  await expectRestoredPrompts(state, page, s.id, 2);
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
    messages: [{ parts: [{ type: "text", text: "Helper prompt" }] }],
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
