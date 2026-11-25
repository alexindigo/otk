// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import { pick, rightClick } from "../../pages/menus.ts";

test.use({ profile: "revert-native" });
test("revert.saved-view-does-not-acknowledge-unseen-live-finishes", {
  tag: ["@revert", "@messages", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Live work behind saved branch",
  });
  await openSession(state, page, source.id);
  await state.queue(["Earlier reply."]);
  await prompt(page, "Earlier prompt");
  await expect(page.locator(".otk-messages")).toContainText("Earlier reply.");
  const row = page.locator(`[data-session="${source.id}"]`);
  await expect(row).toHaveAttribute("data-status", "idle");
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restore conversation", exact: true }),
  ).toBeVisible();
  await state.queue(["Replacement reply."]);
  await prompt(page, "Replacement prompt");
  await expect(page.locator(".otk-messages")).toContainText(
    "Replacement reply.",
  );
  await expect(row.locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "none",
  );
  await rightClick(page, ".otk-messages");
  await pick(page, "Saved conversation copies (1)");
  await state.queue(["New live finish not yet read."]);
  await prompt(page, "Run in the live session while I read the earlier branch");
  await expect(row).toHaveAttribute("data-status", "idle");
  await expect(row.locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "finished",
  );
  await expect(page.locator('.otk-toast[data-kind="done"]')).toContainText(
    "Live work behind saved branch",
  );
  await expect(
    page.getByRole("region", { name: "Saved earlier branch", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", {
    name: "Back to live conversation",
    exact: true,
  }).click();
  await expect(page.locator(".otk-messages")).toContainText(
    "New live finish not yet read.",
  );
  await expect(row.locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "none",
  );
});
