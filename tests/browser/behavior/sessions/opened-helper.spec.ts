// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { activity, sessionContext } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-default" });
test("sessions.explicit-helper-stays-in-roster-until-cleared-or-closed", {
  tag: ["@sessions", "@composer", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const parent = "tstv1-otk", child = "tstv1-urgent-child";
  await state.product("prefs.set", { key: "notify.toast", value: false });
  await state.product("tasks.create", {
    directory: state.directory,
    name: "Review helper",
    sessions: [parent],
  });
  await openSession(state, page, parent);
  const pill = page.getByRole("button", { name: /^Subagents:/ });
  const menu = page.getByRole("menu", { name: "Subagents", exact: true });
  const row = menu.locator(`[data-subagent="${child}"]`);
  await activity(state, child, "hold");
  await expect(pill).toHaveAccessibleName("Subagents: 1 running");
  await pill.click();
  await row.locator(".otk-subagent-name").click();
  await expect(page).toHaveURL(new RegExp(`${child}$`));
  await activity(state, child, "release");
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "release",
    sessionID: child,
    target: "trail-delivery",
  });
  await page.locator(`[data-crumb="${parent}"]`).click();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${parent}$`));
  await expect(pill).toHaveAccessibleName("Subagents: 1 opened");
  await pill.click();
  await expect(row).toBeVisible();
  // A retained delivered child is present without inventing a new unseen lamp.
  await expect(row.locator(".otk-subagent-name .otk-status-light"))
    .toHaveAttribute("data-state", "none");
  await page.getByRole("button", { name: "Clear finished" }).click();
  await expect(pill).toHaveCount(0);
  await expect(page.locator(`[data-session="${child}"]`)).toBeVisible();

  await page.locator(`[data-session="${child}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${child}$`));
  await expect(pill).toHaveAccessibleName("Subagents: 1 opened");
  await sessionContext(page, `[data-session="${child}"]`, "session.close");
  await expect(page).toHaveURL(new RegExp(`${parent}$`));
  await expect(pill).toHaveCount(0);
});
