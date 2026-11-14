// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { openWorkLogs } from "../../pages/transcript.ts";
test.use({ profile: "contract-messages-migrated-history" });
test("messages.migrated-tools-have-typed-patch-target-range-and-agent", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await openSession(state, page, "tstv1-otk");
  await openWorkLogs(page);
  const patch = page.locator("[data-tool=patch]");
  await expect(patch).toHaveCount(1);
  await expect(patch.locator(".otk-tool-toggle")).not.toContainText(
    "apply_patch",
  );
  await expect(patch.locator(".otk-tool-icon")).not.toHaveText("\u25c7");
  const read = page.locator("[data-tool=read]").filter({ hasText: "beta.ts" });
  await expect(read).toContainText("190");
  await expect(read).toContainText("50");
  const task = page.locator("[data-tool=task]");
  await expect(task).toContainText("junior");
  await expect(task).not.toContainText("Unknown agent");
  const unknown = page.locator("[data-tool=external]").filter({
    hasText: "custom",
  });
  await expect(unknown.locator(".otk-tool-verb")).toHaveText("custom");
  await expect(unknown.locator(".otk-tool-brief")).toHaveCount(0);
  const time = page.locator(".otk-turn-time").first();
  await expect(time).toHaveText("Time unknown");
  await expect(time).toHaveAttribute(
    "title",
    "The real end time was lost when opencode migrated this session.",
  );
  await expect(page.locator(".otk-response-progress")).toHaveCount(0);
  await expect(page.locator(".otk-work-fold").first()).toContainText(
    "Work log",
  );
  await expect(page.locator('[data-message="known-call-0"] .otk-turn-time'))
    .toHaveText(
      "Worked for 1.0s",
    );
  await expect(page.locator('[data-message="missing-end-call"] .otk-turn-time'))
    .toHaveText("Time unknown");
  await expect(page.locator('[data-message="missing-end-call"]')).toContainText(
    "interrupted",
  );
});
test("messages.work-log-segments-have-own-times-and-footer-keeps-turn-total", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await openSession(state, page, "tstv1-otk");
  const reply = page.locator('[data-message="segment-call"]');
  const headers = reply.locator(".otk-work-fold");
  await expect(headers).toHaveCount(2);
  await expect(headers.nth(0)).toHaveAttribute("aria-expanded", "false");
  await expect(headers.nth(1)).toHaveAttribute("aria-expanded", "false");
  await expect(headers.nth(0)).toHaveText("Worked for 0.7s");
  await expect(headers.nth(1)).toHaveText("Worked for 0.9s");
  await expect(reply.locator(".otk-turn-time")).toHaveText("Worked for 1.6s");
  await page.reload();
  await expect(headers.nth(0)).toHaveText("Worked for 0.7s");
  await expect(headers.nth(1)).toHaveText("Worked for 0.9s");
  await expect(reply.locator(".otk-turn-time")).toHaveText("Worked for 1.6s");
});
