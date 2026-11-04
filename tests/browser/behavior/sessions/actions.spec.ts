// SPDX-License-Identifier: LGPL-3.0-only
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt, revealAcquired, toolScript } from "../../pages/transcript.ts";
import { contextMenu, sessionContext } from "../../pages/sessions.ts";

test.use({ profile: "revert-native" });
interface Message {
  info: {
    id: string;
    role: string;
    parentID?: string;
    time: { completed?: number };
  };
  parts: { type: string; text?: string }[];
}
async function deletedDetails(page: Page, id: string, title: string) {
  const row = page.locator(`[data-session="${id}"]`);
  await expect(row).toHaveClass(/is-deleted/);
  await expect(row).toHaveAttribute(
    "aria-label",
    new RegExp("^Deleted session, "),
  );
  await expect(row.locator(".otk-row-title")).toHaveText(title);
  await expect(row.locator(".otk-row-title")).toHaveCSS(
    "text-decoration-line",
    /line-through/,
  );
  await row.click();
  await expect(page).toHaveURL(new RegExp(`${id}$`));
  const details = page.locator(".otk-deleted-session");
  await expect(details).toContainText(title);
  await expect(details.locator("dd").filter({ hasText: id })).toBeVisible();
  await expect(details.locator("p")).toHaveText(
    /^Deleted (through OTK|from the agent service) on /,
  );
  await expect(page.locator(".otk-prompt,[data-role=assistant]")).toHaveCount(
    0,
  );
}

test("sessions.compact-real-duration-queued-behind-current-work", {
  tag: ["@sessions", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  test.setTimeout(120_000);
  const s = await state.native<{ id: string }>("/session", "POST", {
    title: "Compact session",
  });
  const background = await state.native<{ id: string }>("/session", "POST", {
    title: "Background session",
  });
  await openSession(state, page, s.id);
  await state.queue(["Context ready."]);
  await prompt(page, "Give context for compaction");
  await expect(page.locator(".otk-messages")).toContainText("Context ready.");
  await expect(page.locator(`[data-session="${s.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await sessionContext(page, `[data-session="${background.id}"]`);
  await expect(
    page.locator(`${contextMenu} [data-context-command="session.compact"]`),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: ["Long compaction summary."],
    delay: 20_000,
  });
  await sessionContext(page, `[data-session="${s.id}"]`, "session.compact");
  await expect(page.locator(".otk-compaction-divider")).toHaveText(
    "Compacting…",
  );
  await expect(page.locator(`[data-session="${s.id}"]`)).toHaveAttribute(
    "data-status",
    "busy",
  );
  await expect(page.locator(".otk-response-progress")).toBeVisible();
  expect(
    await page.locator(".otk-compaction-divider").evaluate((e) =>
      !e.closest(".otk-user-bubble") &&
      !e.closest("[data-message]")!.querySelector(".otk-user-bubble")
    ),
  ).toBe(true);
  await expect(page.locator(".otk-messages")).toContainText(
    "Long compaction summary.",
    { timeout: 30_000 },
  );
  await expect(page.locator(`[data-session="${s.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator(".otk-compaction-divider")).toHaveText(
    "Session compacted",
  );
  await expect(page.locator(".otk-session-error")).toHaveCount(0);
  const first = await state.queue(["Busy reply finished."], "held"),
    summary = await state.queue(["Queued compaction summary."], "held");
  await prompt(page, "Keep working until released");
  await expect(page.locator(`[data-session="${s.id}"]`)).toHaveAttribute(
    "data-status",
    "busy",
  );
  await expect(page.locator(".otk-messages")).toContainText(
    "Busy reply finished.",
  );
  const requests =
    (await state.observe<{ requests: unknown[] }>()).requests.length;
  await sessionContext(page, `[data-session="${s.id}"]`, "session.compact");
  await expect(
    page.locator(".otk-compaction-divider").filter({
      hasText: /^Compacting…$/,
    }),
  ).toBeVisible();
  const history = await state.native<Message[]>(`/session/${s.id}/message`);
  expect(
    history.filter((m) => m.parts.some((p) => p.type === "compaction")).map(
      (m) =>
        history.some((r) =>
            r.info.role === "assistant" && r.info.parentID === m.info.id &&
            r.info.time.completed !== undefined
          )
          ? "Session compacted"
          : "Compacting…",
    ),
  ).toEqual(["Session compacted", "Compacting…"]);
  await expect(page.locator(".otk-message-flow")).toHaveAttribute(
    "data-message-count",
    String(history.length),
  );
  expect((await state.observe<{ requests: unknown[] }>()).requests.length).toBe(
    requests,
  );
  await state.release(first.gate);
  await expect(page.locator(".otk-messages")).toContainText(
    "Queued compaction summary.",
  );
  expect((await state.observe<{ requests: unknown[] }>()).requests.length)
    .toBeGreaterThan(requests);
  await state.release(summary.gate);
  await expect(page.locator(`[data-session="${s.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect.poll(() =>
    page.locator(".otk-compaction-divider").evaluateAll((es) =>
      es.length > 0 &&
      es.every((e) =>
        e.textContent === "Session compacted" && !e.closest(".otk-user-bubble")
      )
    )
  ).toBe(true);
  await expect(page.locator(".otk-session-error")).toHaveCount(0);
});

test("sessions.compact-native-http-failure-one-owned-feedback", {
  tag: ["@sessions", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const s = await state.native<{ id: string }>("/session", "POST", {
    title: "Compact error",
  });
  await openSession(state, page, s.id);
  await expect(page.locator(".otk-model-picker")).toBeVisible();
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "freeze",
  });
  await sessionContext(page, `[data-session="${s.id}"]`, "session.compact");
  await expect(page.locator(".otk-operation-feedback .otk-control-label"))
    .toHaveText("Checking whether this finished");
  await expect(page.locator(".otk-operation-feedback")).toHaveCount(1);
  await expect(page.locator(".otk-session-error")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Compact refused");
});

test(
  "sessions.inclusive-grouped-fork-shared-files-original-draft-and-full-fork",
  { tag: ["@sessions", "@isolated"] },
  async ({ isolatedState: state, page, context }) => {
    const original = await state.native<{ id: string }>("/session", "POST", {
      title: "Fork source",
    });
    await openSession(state, page, original.id);
    await toolScript(state, "bash", {
      command: "pwd",
      description: "Read shared directory",
    }, "First grouped reply.");
    await prompt(page, "First prompt");
    await expect(page.locator(".otk-messages")).toContainText(
      "First grouped reply.",
    );
    await expect(page.locator(`[data-session="${original.id}"]`))
      .toHaveAttribute("data-status", "idle");
    await state.queue(["Second reply."]);
    await prompt(page, "Second prompt");
    await expect(page.locator(".otk-messages")).toContainText("Second reply.");
    await expect(page.locator(`[data-session="${original.id}"]`))
      .toHaveAttribute("data-status", "idle");
    await revealAcquired(page, "[data-role=assistant]");
    await page.locator("[data-role=assistant] .otk-message-agent").first()
      .click();
    await page.locator(
      '[data-role=assistant] [data-message-command="reply.fork"]',
    ).first().click();
    await expect(page).not.toHaveURL(new RegExp(`${original.id}$`));
    await expect(page.locator(".otk-fork-note")).toContainText(
      "Files are shared with the original.",
    );
    const fork = new URL(page.url()).hash.split("/").at(-1)!;
    await expect(page.locator("[data-role=user]")).toHaveCount(1);
    await expect(page.locator("[data-role=assistant]")).toHaveCount(1);
    await expect(page.locator("textarea[name=prompt]")).toHaveValue("");
    expect(
      (await state.native<Message[]>(`/session/${fork}/message`)).map((m) =>
        m.info.role
      ),
    ).toEqual(["user", "assistant", "assistant"]);
    const bubble = page.locator("[data-role=user] .otk-user-bubble");
    await revealAcquired(page, "[data-role=user] .otk-user-bubble");
    await bubble.focus();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: state.url,
    });
    await page.locator('[data-role=user] [data-message-command="prompt.copy"]')
      .click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("First prompt");
    await toolScript(state, "bash", {
      command: "echo shared > fork-shared.txt",
      description: "Write shared file",
    }, "Shared file written.");
    await prompt(page, "Fork writes a shared file");
    await expect(page.locator(".otk-messages")).toContainText(
      "Shared file written.",
    );
    await expect(page.locator(`[data-session="${fork}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
    await expect(page.locator(".otk-fork-note")).toHaveCount(0);
    expect(await readFile(state.directory + "/fork-shared.txt", "utf8")).toBe(
      "shared\n",
    );
    await openSession(state, page, original.id);
    const originalHistory = await state.native<Message[]>(
      `/session/${original.id}/message`,
    );
    const texts = (history: Message[]) =>
      history.filter((m) => m.info.role === "user").flatMap((m) =>
        m.parts.filter((p) => p.type === "text").map((p) => p.text)
      );
    expect(texts(originalHistory)).toEqual(["First prompt", "Second prompt"]);
    await expect(page.locator(".otk-message-flow")).toHaveAttribute(
      "data-message-count",
      String(originalHistory.length),
    );
    await page.locator("textarea[name=prompt]").fill("Keep original draft");
    await sessionContext(
      page,
      `[data-session="${original.id}"]`,
      "session.fork",
    );
    await expect(page).not.toHaveURL(new RegExp(`${original.id}$`));
    await expect(page.locator(".otk-fork-note")).toBeVisible();
    const fullFork = new URL(page.url()).hash.split("/").at(-1)!;
    const history = await state.native<Message[]>(
      `/session/${fullFork}/message`,
    );
    expect(texts(history)).toEqual(["First prompt", "Second prompt"]);
    await expect(page.locator(".otk-message-flow")).toHaveAttribute(
      "data-message-count",
      String(history.length),
    );
    await expect(page.locator("textarea[name=prompt]")).toHaveValue("");
    await page.getByRole("button", { name: "Dismiss fork note", exact: true })
      .click();
    await expect(page.locator(".otk-fork-note")).toHaveCount(0);
    await openSession(state, page, original.id);
    await expect(page.locator("textarea[name=prompt]")).toHaveValue(
      "Keep original draft",
    );
  },
);

test(
  "sessions.rename-only-invoking-tab-chip-row-cancel-empty-blur-and-reload",
  { tag: ["@sessions", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const s = await state.native<{ id: string }>("/session", "POST", {
      title: "Session actions",
    });
    await openSession(state, page, s.id);
    for (
      const [origin, selector] of [["tab", `[data-tab="${s.id}"]`], [
        "chip",
        `[data-crumb="${s.id}"]`,
      ], ["row", `[data-session="${s.id}"]`]]
    ) {
      await sessionContext(page, selector, "session.rename");
      const editor = page.locator(".otk-title-editor");
      await expect(editor).toHaveCount(1);
      await expect(editor).toHaveAttribute("data-origin", origin);
      await expect(editor.locator("input")).toBeFocused();
      expect(
        await editor.locator("input").evaluate((e) =>
          (e as HTMLInputElement).selectionStart === 0 &&
          (e as HTMLInputElement).selectionEnd ===
            (e as HTMLInputElement).value.length
        ),
      ).toBe(true);
      await page.keyboard.insertText(`Renamed from ${origin}`);
      await page.keyboard.press("Enter");
      await expect(editor).toHaveCount(0);
      await expect(page.locator(`[data-session="${s.id}"] .otk-row-title`))
        .toHaveText(`Renamed from ${origin}`);
      expect((await state.native<{ title: string }>(`/session/${s.id}`)).title)
        .toBe(`Renamed from ${origin}`);
    }
    await sessionContext(page, `[data-session="${s.id}"]`, "session.rename");
    await page.locator(".otk-title-editor input").fill("Cancelled title");
    await page.keyboard.press("Escape");
    await expect(page.locator(".otk-title-editor")).toHaveCount(0);
    await sessionContext(page, `[data-session="${s.id}"]`, "session.rename");
    await page.locator(".otk-title-editor input").fill("");
    await page.keyboard.press("Enter");
    await expect(page.locator(".otk-title-editor")).toHaveCount(0);
    await sessionContext(page, `[data-session="${s.id}"]`, "session.rename");
    await page.locator(".otk-title-editor input").fill("Committed on blur");
    await page.locator("textarea[name=prompt]").click();
    await expect(page.locator(".otk-title-editor")).toHaveCount(0);
    await expect(page.locator(`[data-session="${s.id}"] .otk-row-title`))
      .toHaveText("Committed on blur");
    await page.reload();
    await expect(page.locator(`[data-session="${s.id}"] .otk-row-title`))
      .toHaveText("Committed on blur");
  },
);

test(
  "sessions.working-family-delete-aborts-before-removal-and-retains-details",
  { tag: ["@sessions", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const root = await state.native<{ id: string; nativeID: string }>(
      "/session",
      "POST",
      { title: "Working family" },
    );
    const child = await state.native<{ id: string }>("/session", "POST", {
      title: "Family helper",
      parentID: root.id,
    });
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: Array(30).fill("Still working. "),
      delay: 1000,
    });
    await state.product("session.prompt", {
      sessionID: root.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Keep working until interrupted" }],
      model: { provider: "fake", model: "scripted" },
    });
    await openSession(state, page, root.id);
    await expect(page.locator(`[data-session="${root.id}"]`)).toHaveAttribute(
      "data-status",
      "busy",
    );
    // Admission precedes provider acquisition. Delete actual streaming work,
    // not an admitted request whose queued script has not been consumed yet.
    await expect(page.locator("[data-role=assistant] .otk-text"))
      .toContainText("Still working.");
    const item = page.locator(
      `${contextMenu} [data-context-command="session.delete"]`,
    );
    await sessionContext(page, `[data-tab="${root.id}"]`);
    await item.click();
    await expect(item).toHaveText(
      "Press again to stop and delete, including 1 helper",
    );
    await page.keyboard.press("Escape");
    await sessionContext(page, `[data-tab="${root.id}"]`);
    await item.click();
    await expect(item).toHaveClass(/is-armed/);
    await item.click();
    await expect(
      page.locator(`[data-tab="${root.id}"],[data-tab="${child.id}"]`),
    ).toHaveCount(0);
    await expect(page).toHaveURL(/#project\//);
    expect(
      (await state.observe<{ transport: { mutationDetails: string[] } }>())
        .transport.mutationDetails,
    ).toEqual([
      `POST /session/${root.nativeID}/abort`,
      `DELETE /session/${root.nativeID}`,
    ]);
    await expect(state.native(`/session/${child.id}`)).rejects.toThrow("404");
    await deletedDetails(page, root.id, "Working family");
    await deletedDetails(page, child.id, "Family helper");
  },
);

test("sessions.delete-dirty-guard-pointer-keyboard-disarm-native-removal", {
  tag: ["@sessions", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const s = await state.native<{ id: string; nativeID: string }>(
    "/session",
    "POST",
    { title: "Draft to protect" },
  );
  await openSession(state, page, s.id);
  await page.locator("textarea[name=prompt]").fill("Keep this unsent draft");
  const dialogs: string[] = [];
  let accept = false;
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void (accept ? d.accept() : d.dismiss());
  });
  await sessionContext(page, `[data-tab="${s.id}"]`, "session.close");
  await expect(page).toHaveURL(/#project\//);
  expect(dialogs).toEqual([]);
  await openSession(state, page, s.id);
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Keep this unsent draft",
  );
  const item = page.locator(
    `${contextMenu} [data-context-command="session.delete"]`,
  );
  await sessionContext(page, `[data-session="${s.id}"]`);
  await expect(
    page.locator(`${contextMenu} [data-context-command="session.compact"]`),
  ).toBeVisible();
  await item.click();
  await expect(item).toHaveText("Press again to delete");
  await item.click();
  await expect(page.locator(contextMenu)).toHaveCount(0);
  expect((await state.native<{ id: string }>(`/session/${s.id}`)).id).toBe(
    s.nativeID,
  );
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Keep this unsent draft",
  );
  accept = true;
  await sessionContext(page, `[data-tab="${s.id}"]`);
  await item.click();
  await expect(item).toHaveText("Press again to delete");
  await item.click();
  await expect(page.locator(`[data-tab="${s.id}"]`)).toHaveCount(0);
  await expect(page).toHaveURL(/#project\//);
  await expect(state.native(`/session/${s.id}`)).rejects.toThrow("404");
  await deletedDetails(page, s.id, "Draft to protect");
  const empty = await state.native<{ id: string }>("/session", "POST", {
    title: "Empty draft",
  });
  await openSession(state, page, empty.id);
  await sessionContext(page, `[data-tab="${empty.id}"]`);
  await expect(
    page.locator(`${contextMenu} [data-context-command="session.compact"]`),
  ).toBeVisible();
  await item.click();
  await expect(item).toHaveText("Press again to delete");
  await page.locator(`${contextMenu} [data-context-command="session.rename"]`)
    .hover();
  await expect(item).toHaveText("Delete");
  await item.click();
  await expect(item).toHaveText("Press again to delete");
  await page.keyboard.press("ArrowUp");
  await expect(item).toHaveText("Delete");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(item).toHaveText("Press again to delete");
  await page.keyboard.press("Tab");
  await expect(page.locator(contextMenu)).toHaveCount(0);
  await sessionContext(page, `[data-tab="${empty.id}"]`);
  await item.click();
  await expect(item).toHaveText("Press again to delete");
  const before = dialogs.length;
  await item.click();
  await expect(page.locator(`[data-tab="${empty.id}"]`)).toHaveCount(0);
  await expect(page).toHaveURL(/#project\//);
  expect(dialogs).toHaveLength(before);
  await expect(state.native(`/session/${empty.id}`)).rejects.toThrow("404");
  await deletedDetails(page, empty.id, "Empty draft");
});
