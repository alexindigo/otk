// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  openWork,
  revealAcquired,
  revealTool,
} from "../../pages/transcript.ts";
test.use({ profile: "contract-messages-migrated-history" });
test("messages.migrated-tools-have-typed-patch-target-range-and-agent", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await openSession(state, page, "tstv1-otk");
  const historical = '[data-message="msg_inve00000000000000000000002"]';
  await revealAcquired(page, `${historical} .otk-work-strip`);
  const work = await openWork(page.locator(historical));
  const patch = work.locator("[data-tool=patch]");
  await expect(patch).toHaveCount(1);
  await expect(patch.locator(".otk-tool-toggle")).not.toContainText(
    "apply_patch",
  );
  // 2.114/dx-2 moved the tool art into the disclosure, not the tree's node slot.
  const art = patch.locator(
    ":scope > .otk-tree-node > .otk-tree-heading > .otk-tool-toggle > .otk-disclosure-lead",
  );
  await expect(art.locator("svg")).toBeVisible();
  await expect(art).not.toHaveText("\u25c7");
  const read = await revealTool(
    page,
    '[data-tool=read]:has-text("beta.ts")',
    page.locator(historical),
  );
  await expect(read).toContainText("190");
  await expect(read).toContainText("50");
  const task = work.locator("[data-tool=task]");
  await expect(task).toContainText("junior");
  await expect(task).not.toContainText("Unknown agent");
  const unknown = work.locator("[data-tool=external]").filter({
    hasText: "custom",
  });
  await expect(unknown.locator(".otk-tool-toggle")).toHaveText("custom");
  await expect(unknown.locator(".otk-work-tool-summary")).toHaveCount(0);
  const time = page.locator(".otk-turn-time").first();
  await expect.soft(time).toHaveText("Time unknown");
  await expect.soft(time).toHaveAttribute(
    "title",
    "The real end time was lost when opencode migrated this session.",
  );
  await expect(page.locator(".otk-response-progress")).toHaveCount(0);
  await expect(page.locator(".otk-work-strip").first()).toContainText(
    "Work log",
  );
  await expect(page.locator('[data-message="known-call-0"] .otk-turn-time'))
    .toHaveText(
      "Worked for 1s",
    );
  await expect(page.locator('[data-message="missing-end-call"] .otk-turn-time'))
    .toHaveText("Time unknown");
  await expect(page.locator('[data-message="missing-end-call"]')).toContainText(
    "interrupted",
  );
});
test("messages.work-log-segments-keep-their-name-and-footer-owns-turn-time", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await openSession(state, page, "tstv1-otk");
  const reply = page.locator('[data-message="segment-call"]');
  const header = reply.locator(".otk-work-strip");
  const assertWorkLog = async () => {
    await expect(header).toHaveCount(1);
    await expect(header).toContainText("Work log");
    await expect(reply.locator(".otk-turn-time")).toHaveText("Worked for 1.6s");
  };
  await assertWorkLog();
  await expect(header).not.toHaveAttribute("aria-current", "true");
  for (const detail of [false, true]) {
    await state.product("prefs.set", { key: "toolDetails", value: detail });
    await assertWorkLog();
    await page.reload();
    await assertWorkLog();
  }
  await page.reload();
  await assertWorkLog();
  const panel = await openWork(reply);
  // One thinking span separates the first two reads from the third read.
  await panel.getByRole("button", { name: "Read 2 files", exact: true })
    .click();
  await expect(panel.locator("[data-tool=read]")).toHaveCount(3);
});
