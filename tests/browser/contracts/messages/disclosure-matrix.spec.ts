// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  expandTool,
  openWork,
  prompt,
  recordToggle,
} from "../../pages/transcript.ts";
import {
  labelDisclosure,
  transcriptVisibility,
} from "../disclosure-contract.ts";

const tags = { tag: ["@messages", "@contracts"] };

test.describe("reply record disclosures", () => {
  test.use({ profile: "contract-messages-disclosures" });
  const snapshot = (work: Locator) =>
    work.locator('[data-native-record="opencode-v1/snapshot"]').first();
  const count = (work: Locator) =>
    work.locator('button[data-record-kind="snapshots"]');

  for (
    const [id, find] of [
      [
        "tool",
        (work: Locator) =>
          work.locator("[data-tool=write] .otk-tool-toggle").first(),
      ],
      ["recordKinds", count],
      ["record", async (work: Locator) => {
        await count(work).press("ArrowRight");
        return recordToggle(snapshot(work));
      }],
      ["source", async (work: Locator) => {
        await count(work).press("ArrowRight");
        await recordToggle(snapshot(work)).press("ArrowRight");
        return snapshot(work).getByRole("button", {
          name: "Source",
          exact: true,
        });
      }],
    ] as const
  ) {
    test(
      `messages.disclosure.${id}`,
      tags,
      async ({ isolatedState: state, page }) => {
        await state.controller.call("scenario", {
          lease: state.lease.lease,
          action: "hold",
        });
        await openSession(state, page, "tstv1-otk");
        const reply = page.locator('[data-message="reply"]');
        const acquire = async () => await find(await openWork(reply));
        const trigger = await acquire();
        await labelDisclosure(trigger, false, true);
        await trigger.press("ArrowRight");
        await transcriptVisibility(page, false);
        await expect(reply).toHaveCount(0);
        await transcriptVisibility(page, true);
        await expect(await acquire()).toHaveAttribute("aria-expanded", "true");
        await page.reload();
        await expect(await acquire()).toHaveAttribute("aria-expanded", "false");
      },
    );
  }
});

test.describe("reasoning in reply work", () => {
  test.use({ profile: "contract-messages-reading" });
  test(
    "messages.disclosure.reasoning",
    tags,
    async ({ isolatedState: state, page }) => {
      await page.setViewportSize({ width: 1560, height: 980 });
      await openSession(state, page, "tstv1-otk");
      const reply = page.locator('[data-role="assistant"]', {
        has: page.locator(".otk-work-strip"),
      });
      const find = async () => {
        const work = await openWork(reply);
        // This thought precedes the project-directory command. Its disclosure
        // lives in that run's detail, not alongside the transcript's prose.
        await expandTool(page, "[data-tool=bash]", reply);
        return work.locator(".otk-reasoning-heading");
      };
      const trigger = await find();
      await labelDisclosure(trigger, false, true);
      await trigger.press("ArrowRight");
      await transcriptVisibility(page, false);
      await expect(reply).toHaveCount(0);
      await transcriptVisibility(page, true);
      await expect(await find()).toHaveAttribute("aria-expanded", "true");
      await page.reload();
      await expect(await find()).toHaveAttribute("aria-expanded", "false");
    },
  );
});

test.describe("background activity", () => {
  test.use({ profile: "contract-messages-running-layout" });
  test(
    "messages.disclosure.activity",
    tags,
    async ({ isolatedState: state, page }) => {
      const { session } = await state.observe<{ session: string }>();
      await page.setViewportSize({ width: 1560, height: 980 });
      await openSession(state, page, session);
      for (const action of ["freeze", "release"] as const) {
        await state.controller.call("scenario", {
          lease: state.lease.lease,
          target: "backgrounds",
          action,
        });
      }
      const trigger = page.locator(
        "[data-background-interval] .otk-record-group-toggle",
      ).first();
      await labelDisclosure(trigger);
      await trigger.press("ArrowRight");
      await transcriptVisibility(page, false);
      await expect(trigger).toHaveCount(0);
      await transcriptVisibility(page, true);
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await page.reload();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
    },
  );
});

test.describe("saved revert", () => {
  test.use({ profile: "revert-native" });
  test(
    "messages.disclosure.revert",
    tags,
    async ({ isolatedState: state, page }) => {
      const session = await state.native<{ id: string }>("/session", "POST", {
        title: "Revert disclosure",
      });
      await openSession(state, page, session.id);
      await state.queue(["Reply before reverting."]);
      await prompt(page, "Prompt to revert");
      await expect(page.locator(".otk-messages")).toContainText(
        "Reply before reverting.",
      );
      await expect(page.locator(`[data-session="${session.id}"]`))
        .toHaveAttribute(
          "data-status",
          "idle",
        );
      await page.locator(".otk-user-bubble").focus();
      await page.locator('[data-message-command="prompt.revert"]').click();
      await page.getByRole("button", { name: "Confirm revert", exact: true })
        .click();
      const revert = page.locator(".otk-revert-group");
      await expect(revert).toHaveAttribute("data-phase", "saved");
      const trigger = revert.getByRole("button", { name: /^Reverted from/ });
      await labelDisclosure(trigger);
      await trigger.press("ArrowRight");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await page.reload();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
    },
  );
});
