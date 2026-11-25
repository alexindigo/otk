// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { contextMenu, pick, rightClick } from "../../pages/menus.ts";
import { prompt } from "../../pages/transcript.ts";
import type { ServerFrame } from "@otk/protocol";

test.use({ profile: "revert-native" });
test("revert.only-native-commit-marks-replaced", {
  tag: ["@revert", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  const transport = await wire(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Conversation copies",
  });
  const row = page.locator(`[data-session="${session.id}"]`);
  const messages = page.locator(".otk-messages");
  const saved = page.getByRole("region", {
    name: "Saved earlier branch",
    exact: true,
  });
  const openMenu = () => rightClick(page, row);
  const stage = async () => {
    await expect(row).toHaveAttribute("data-status", "idle");
    await page.locator(".otk-user-bubble").focus();
    await page.locator('[data-message-command="prompt.revert"]').click();
    await page.getByRole("button", { name: "Confirm revert", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Open copy", exact: true }))
      .toBeVisible();
  };
  await openSession(state, page, session.id);
  const welcome = transport.received.find((frame) => frame.t === "welcome") as
    | Extract<ServerFrame, { t: "welcome" }>
    | undefined;
  expect(welcome).toBeDefined();
  const confirms =
    welcome?.sidecar.harness.capabilities?.includes("revertCommit") ?? false;
  expect(confirms).toBe(info.project.name === "oc-2.2.6");
  await state.queue(["Original reply: Keep the logs with the report."]);
  await prompt(page, "What should we keep with the report?");
  await expect(messages).toContainText("Keep the logs with the report.");
  await stage();
  await page.getByRole("button", { name: "Restore conversation", exact: true })
    .click();
  await expect(messages).toContainText("Keep the logs with the report.");
  await openMenu();
  await pick(page, "Saved conversation copies (1)");
  await expect(saved).toContainText("Saved before a revert, not replaced");
  await expect(saved).not.toContainText("Replaced when a revert was committed");
  const back = saved.getByRole("button", {
    name: "Back to live conversation",
    exact: true,
  });
  await back.click();
  await stage();
  await state.queue(["Updated reply: Keep the summary with the report."]);
  await prompt(page, "Keep only the summary this time.");
  await expect(messages).toContainText("Keep the summary with the report.");
  await expect(
    page.getByRole("button", { name: "Saved earlier branches", exact: true }),
  ).toHaveCount(0);
  for (
    const [label, theme] of [["dark", "otk-dark"], ["linen", "otk-light"], [
      "stone",
      "otk-light-stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await openMenu();
    const entry = contextMenu(page).getByRole("menuitem", {
      name: "Saved conversation copies (2)",
      exact: true,
    });
    await expect(entry).toBeVisible();
    if (confirms) {
      await page.screenshot({
        path: info.outputPath(`saved-copies-menu-${label}.png`),
        fullPage: true,
      });
    }
    await entry.click();
    await expect(saved).toContainText(
      confirms
        ? "Replaced when a revert was committed"
        : "Saved before a revert, not replaced",
    );
    if (!confirms) {
      await expect(saved).not.toContainText(
        "Replaced when a revert was committed",
      );
    }
    await expect(saved).toContainText("Keep the logs with the report.");
    if (confirms) {
      await page.screenshot({
        path: info.outputPath(`saved-copy-view-${label}.png`),
        fullPage: true,
      });
    }
    await back.click();
  }
});
