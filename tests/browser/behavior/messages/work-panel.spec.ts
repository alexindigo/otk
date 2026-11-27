// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  prompt,
  settledNativeReply,
  toolScript,
} from "../../pages/transcript.ts";

test.use({ profile: "messages-forms" });
const tags = { tag: ["@messages", "@isolated"] };
const olderPrompt = "Find the earlier project directory.";
const latestPrompt = "Check the current working directory.";
const olderAction = "Find project directory";
const latestAction = "Verify working directory";

const panel = (page: Page) => page.getByRole("tabpanel", { name: "Work log" });
const tab = (page: Page) =>
  page.getByRole("tab", { name: "Work log", exact: true });
const identity = (page: Page) =>
  panel(page).getByRole("button", { name: "Show reply" });
const previous = (page: Page) =>
  panel(page).getByRole("button", { name: "Previous reply" });
const next = (page: Page) =>
  panel(page).getByRole("button", { name: "Next reply" });
const rows = (page: Page) => panel(page).locator("[data-work-run]");

async function start(state: TestState, page: Page) {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Work log review",
  });
  await openSession(state, page, session.id);
  return session.id;
}

async function command(
  state: TestState,
  page: Page,
  session: string,
  text: string,
  description: string,
  shell = "pwd",
) {
  const answer = `Finished: ${description}.`;
  await toolScript(state, "bash", { command: shell, description }, answer);
  await prompt(page, text);
  await settledNativeReply(state, session, answer);
  await expect(page.locator(".otk-message-flow")).toContainText(answer);
}

async function twoReplies(state: TestState, page: Page) {
  const session = await start(state, page);
  await command(state, page, session, olderPrompt, olderAction);
  await command(state, page, session, latestPrompt, latestAction);
  await tab(page).click();
  await expect(identity(page)).toContainText(latestPrompt);
  return session;
}

test(
  "messages.work-panel.view",
  tags,
  async ({ isolatedState: state, page }) => {
    await twoReplies(state, page);
    await expect(previous(page)).toBeEnabled();
    await expect(next(page)).toBeDisabled();
    await expect(identity(page)).toContainText("1 action");
    await expect(identity(page)).toContainText("Worked for");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText([latestAction]);
    await expect(rows(page).first()).not.toContainText(
      /Step started|Step finished|Execution succeeded|Thought for/,
    );
  },
);

test(
  "messages.work-panel.prev-next",
  tags,
  async ({ isolatedState: state, page }) => {
    const session = await twoReplies(state, page);
    await previous(page).click();
    await expect(identity(page)).toContainText(olderPrompt);
    await expect(previous(page)).toBeDisabled();
    await command(
      state,
      page,
      session,
      "Inspect the directory once more.",
      "Inspect the directory",
    );
    await expect(identity(page)).toContainText(olderPrompt);
    await next(page).click();
    await expect(identity(page)).toContainText(latestPrompt);
    await next(page).click();
    await expect(identity(page)).toContainText(
      "Inspect the directory once more.",
    );
    await expect(next(page)).toBeDisabled();
    await command(
      state,
      page,
      session,
      "List the files one more time.",
      "List project files",
    );
    await expect(identity(page)).toContainText("List the files one more time.");
  },
);

test(
  "messages.work-panel.live",
  tags,
  async ({ isolatedState: state, page }) => {
    const session = await start(state, page);
    await tab(page).click();
    await expect(panel(page)).toContainText("No work in this session yet.");
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: [],
      tool: {
        name: "bash",
        input: {
          command: "sleep 5; pwd",
          description: "Inspect the active directory",
        },
      },
    });
    const held = await state.queue(["The active directory is ready."], "held");
    await prompt(page, "Check the active directory.");
    await expect(rows(page).first()).toContainText(/running.*\d.*s/i);
    await expect(rows(page).first().locator(".otk-activity-indicator"))
      .toBeVisible();
    await expect(identity(page).locator("em")).toHaveText("counting...");
    await expect(rows(page).first()).not.toContainText(/running/i);
    await expect(rows(page).first()).toContainText(/5(?:\.\d+)?s/);
    await state.release(held.gate);
    await settledNativeReply(state, session, "The active directory is ready.");
    await expect(identity(page)).toContainText("Worked for");
  },
);

test(
  "messages.work-panel.failure-row",
  tags,
  async ({ isolatedState: state, page }) => {
    const session = await start(state, page);
    await command(
      state,
      page,
      session,
      "Run the failing command.",
      "Expected failure",
      "exit 7",
    );
    await tab(page).click();
    const row = rows(page).first();
    await expect(row).toHaveClass(/\bis-failed\b/);
    await expect(row.locator(".otk-tool-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(row.getByRole("alert")).toContainText("Exited with code 7");
  },
);

test(
  "messages.work-panel.merged-run",
  tags,
  async ({ isolatedState: state, page }) => {
    const session = await start(state, page);
    for (const file of ["probe.txt", "AGENTS.md"]) {
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [],
        tool: {
          name: "read",
          input: { filePath: `${state.directory}/src/${file}` },
        },
      });
    }
    await state.queue(["I read the requested files."]);
    await prompt(page, "Read the probe and local guide.");
    await settledNativeReply(state, session, "I read the requested files.");
    await tab(page).click();
    const group = rows(page).filter({
      has: page.getByRole("button", { name: "Read 2 files", exact: true }),
    });
    await expect(group).toHaveCount(1);
    const trigger = group.getByRole("button", {
      name: "Read 2 files",
      exact: true,
    });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(group.locator("[data-tool=read]")).toHaveCount(2);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  },
);

test(
  "messages.work-panel.reload",
  tags,
  async ({ isolatedState: state, page }) => {
    await twoReplies(state, page);
    await previous(page).click();
    await expect(identity(page)).toContainText(olderPrompt);
    await page.reload();
    await expect(tab(page)).toHaveAttribute("aria-selected", "true");
    await expect(identity(page)).toContainText(latestPrompt);
  },
);

test(
  "messages.work-panel.show-reply-in-sheet",
  tags,
  async ({ isolatedState: state, page }) => {
    await twoReplies(state, page);
    await previous(page).click();
    await page.setViewportSize({ width: 720, height: 800 });
    await expect(
      page.getByRole("button", { name: "Back to conversation", exact: true }),
    ).toBeVisible();
    await identity(page).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(
      page.locator("[data-role=assistant]").filter({
        hasText: `Finished: ${olderAction}.`,
      }),
    ).toBeInViewport();
  },
);

test(
  "messages.work-panel.sample-2115",
  tags,
  async ({ isolatedState: state, page }) => {
    // Same native multi-step sample as messages.native-work-log-omits-step-and-success-bookkeeping.
    const session = await start(state, page);
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: [],
      tool: {
        name: "bash",
        input: { command: "pwd", description: olderAction },
      },
    });
    await command(
      state,
      page,
      session,
      "Find the project directory and run the verification command.",
      "Verify the test command",
      "exit 7",
    );
    await tab(page).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page)).toContainText([
      olderAction,
      "Verify the test command",
    ]);
    for (const row of await rows(page).all()) {
      await expect(row).not.toContainText(
        /Step started|Step finished|Execution succeeded|Thought for/,
      );
    }
    await expect(panel(page)).toContainText("Also recorded");
    await panel(page).getByRole("button", { name: /step marker/i }).click();
    await expect(panel(page).getByText("Step started", { exact: true }).first())
      .toBeVisible();
    await expect(rows(page)).toHaveCount(2);
  },
);
