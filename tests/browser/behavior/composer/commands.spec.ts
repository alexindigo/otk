// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt, reply } from "../../pages/composer.ts";
import {
  composerError,
  rejectedComposerInput,
  reloadComposerError,
} from "../../pages/composer-error.ts";

test.use({ profile: "composer-commands" });
test("composer.native-project-mcp-skill-slash-multiline-and-dirty-new", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Commands",
  });
  await openSession(state, page, session.id);
  await prompt(page).pressSequentially("/pro");
  await expect(page.locator(".otk-autocomplete")).toContainText("/probe");
  await prompt(page).press("Enter");
  await expect(prompt(page)).toHaveValue("/probe ");
  // Preserve the original single native multiline insertion, rather than
  // introducing per-character Enter/autocomplete handling into this journey.
  await expect(prompt(page)).toBeFocused();
  await page.keyboard.insertText("inline args\ncontinued arguments");
  await expect(prompt(page)).toHaveValue(
    "/probe inline args\ncontinued arguments",
  );
  await state.queue(["Project command received."]);
  await prompt(page).press("Enter");
  await expect(
    page.locator("[data-role=user] .otk-text").filter({
      hasText: "COMMAND-FIXTURE inline args",
    }),
  ).toContainText("continued arguments");
  await expect(prompt(page)).toHaveValue("");
  await reply(state, page, session.id, "Project command received.");
  await state.queue(["Skill command received."]);
  await prompt(page).fill("/canary ");
  await prompt(page).press("Enter");
  await expect(
    page.locator(".otk-message .otk-text").filter({
      hasText: "SKILL-FIXTURE content",
    }),
  ).toBeVisible();
  await reply(state, page, session.id, "Skill command received.");
  const catalog = await state.product("commands.list", {
    sessionID: session.id,
  });
  // V2's command catalog intentionally reports no source provenance.
  const command = catalog.find((command) =>
    command.name.includes("fixture-prompt")
  )!;
  await state.queue(["MCP command received."]);
  await prompt(page).fill(`/${command.name} topic-value`);
  await prompt(page).press("Enter");
  await expect(
    page.locator("[data-role=user] .otk-text").filter({
      hasText: "MCP prompt topic: topic-value",
    }),
  ).toBeVisible();
  await reply(state, page, session.id, "MCP command received.");
  const observed = await state.observe<
    { requests: { messages: unknown }[]; mcpRequests: { method: string }[] }
  >();
  expect(
    observed.requests.some((request) =>
      JSON.stringify(request.messages).includes("MCP prompt topic: topic-value")
    ),
  ).toBe(true);
  expect(
    observed.mcpRequests.some((request) => request.method === "prompts/get"),
  ).toBe(true);
  await prompt(page).fill("/editor");
  await expect(page.locator(".otk-autocomplete")).toContainText("/editor");
  await prompt(page).press("Enter");
  await expect(page.locator("dialog[open]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const before = (await state.native<{ id: string }[]>("/session")).length;
  await prompt(page).fill("/new unsent text");
  await prompt(page).press("Enter");
  await expect(page).not.toHaveURL(new RegExp(session.id + "$"));
  await expect(prompt(page)).toHaveValue("");
  await openSession(state, page, session.id);
  await expect(prompt(page)).toHaveValue("unsent text");
  expect((await state.native<{ id: string }[]>("/session")).length).toBe(
    before + 1,
  );
  await prompt(page).fill("/new");
  await expect(page.locator(".otk-autocomplete")).toContainText("/new");
  await prompt(page).press("Enter");
  await expect(page).not.toHaveURL(new RegExp(session.id + "$"));
  await expect(prompt(page)).toHaveValue("");
});
test.describe("long command", () => {
  test.use({ profile: "composer-long-command" });
  test(
    "composer.long-slash-retains-unconfirmed-and-newer-draft-until-real-completion",
    { tag: ["@composer", "@isolated", "@duration"] },
    async ({ isolatedState: state, page }) => {
      test.setTimeout(120_000);
      const held = await state.controller.call<{ gate: string }>(
        "queueScript",
        {
          lease: state.lease.lease,
          chunks: ["Long slash ", "finished."],
          delay: 16000,
          gate: "held",
        },
      );
      const session = await state.native<{ id: string }>("/session", "POST", {
        title: "Long slash",
      });
      await openSession(state, page, session.id);
      await prompt(page).fill("/probe multiline\narguments");
      await prompt(page).press("Enter");
      await expect(prompt(page)).toHaveValue("/probe multiline\narguments");
      await expect(page.locator("[data-role=user] .otk-text")).toContainText(
        "LONG-COMMAND multiline",
      );
      await expect(page.locator(".otk-operation-feedback[role=status]"))
        .toContainText("Running command");
      await prompt(page).fill("keep the next draft");
      await expect(prompt(page)).toBeEditable();
      await expect(
        page.locator(
          ".otk-prompt button[type=submit], .otk-composer-dock [role=alert]",
        ),
      ).toHaveCount(0);
      await state.release(held.gate);
      await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
        "Long slash finished.",
        { timeout: 60_000 },
      );
      await expect(
        page.locator(".otk-message[data-role=assistant] .otk-streaming"),
      ).toHaveCount(0);
      await expect(prompt(page)).toHaveValue("keep the next draft");
      await expect(page.locator(".otk-prompt [role=alert]")).toHaveCount(0);
    },
  );
});
test("composer.deferred-slash-failure-keeps-new-draft-and-reloads-authority", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string; nativeID: string }>(
    "/session",
    "POST",
    {
      title: "Slash failure",
    },
  );
  const frames = await wire(page);
  await openSession(state, page, session.id);
  await prompt(page).fill("keep this draft");
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "fail",
    sessionID: session.nativeID,
  });
  if (state.controller.info!.version.startsWith("2.")) {
    await rejectedComposerInput(
      state,
      page,
      session.id,
      "command",
    );
    return;
  }
  await expect(page.locator(".otk-session-error")).toBeVisible();
  const snapshot = await composerError(state, page, frames, session.id);
  expect(snapshot.error).toMatch(/^Command not found: "missing-otk-command"\./);
  await expect(prompt(page)).toHaveValue("keep this draft");
  await reloadComposerError(state, page, frames, session.id, snapshot);
  expect((await state.observe<{ requests: unknown[] }>()).requests)
    .toHaveLength(0);
});
