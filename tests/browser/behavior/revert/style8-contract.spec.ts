// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  prompt,
  revealAcquired,
  scrollTranscript,
} from "../../pages/transcript.ts";
import { messages } from "../../pages/composer.ts";

test.use({ profile: "revert-native", viewport: { width: 1280, height: 800 } });
const boundaryText =
  "The boundary prompt must remain identifiable when saving its earlier branch fails, even with a long first line";

for (
  const contract of [
    "geometry",
    "dismiss",
    "restore",
    "cancel-and-other-client",
  ]
) {
  test(
    `revert.style8-${contract}`,
    { tag: ["@revert", "@isolated"] },
    async ({ isolatedState: state, page }, info) => {
      test.setTimeout(180_000);
      const source = await state.native<{ id: string }>("/session", "POST", {
        title: "Revert ownership contract",
      });
      await openSession(state, page, source.id);
      for (const text of ["Earlier live prompt", boundaryText]) {
        await state.queue(["Reply to " + text]);
        await prompt(page, text);
        await expect(page.locator(".otk-messages")).toContainText(
          "Reply to " + text,
        );
        await expect(page.locator(`[data-session="${source.id}"]`))
          .toHaveAttribute("data-status", "idle");
      }
      const records = await messages(state, source.id);
      const boundary = records.find((m) =>
        m.parts.some((p) => p.text === boundaryText)
      )!.info.id;
      const group = page.locator(".otk-revert-group");
      const request = async () => {
        const selector = `[data-message="${boundary}"] .otk-user-bubble`;
        await revealAcquired(page, selector);
        const bubble = page.locator(selector);
        await bubble.scrollIntoViewIfNeeded();
        await bubble.focus();
        await bubble.locator("..").locator(
          '[data-message-command="prompt.revert"]',
        ).click();
        await page.getByRole("button", { name: "Confirm revert", exact: true })
          .click();
      };
      const storage = async (fail: boolean) => {
        await page.evaluate((fail) => {
          const saved = Reflect.get(globalThis, "style8Storage") ??
            Storage.prototype.setItem;
          Reflect.set(globalThis, "style8Storage", saved);
          Storage.prototype.setItem = fail
            ? function (this: Storage, key: string, value: string) {
              if (key.startsWith("otk.branch-history")) {
                throw new DOMException("full", "QuotaExceededError");
              }
              saved.call(this, key, value);
            }
            : saved;
        }, fail);
      };
      const position = () =>
        group.locator(".otk-revert-label").evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, width: r.width };
        });
      if (
        contract === "geometry" || contract === "cancel-and-other-client"
      ) await storage(true);
      await request();
      if (contract === "geometry") {
        // No scroll/reveal helper after Confirm: the owning viewport must reveal it.
        await expect(group.getByRole("button", { name: "Retry", exact: true }))
          .toBeInViewport();
        const failed = await position();
        expect.soft(failed.width).toBeGreaterThanOrEqual(400);
        await storage(false);
        await group.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(group).toHaveAttribute("data-phase", "saved");
        const saved = await position();
        expect.soft(Math.abs(failed.x - saved.x)).toBeLessThanOrEqual(1);
        expect.soft(failed.width).toBeGreaterThanOrEqual(saved.width - 90);
        await expect(
          group.locator(".otk-record-group-heading .otk-failure-content"),
        ).toHaveCount(0);
        return;
      }
      if (contract === "cancel-and-other-client") {
        await scrollTranscript(page, true);
        await expect(group).toContainText("Retry");
        await expect(group.locator(".otk-failure-signal")).toHaveCount(1);
        const top = await page.locator(".otk-session-view").evaluate((el) =>
          el.getBoundingClientRect().top
        );
        await page.locator("textarea[name=prompt]").fill(
          "Keep this replacement draft",
        );
        await page.locator("textarea[name=prompt]").press("Enter");
        const choice = page.locator(".otk-permanence-choice");
        await expect(choice).toBeVisible();
        // An explicit Send choice grows in flow, unlike asynchronous runtime
        // feedback. Its composer still begins exactly at the transcript edge.
        await expect(page.locator(".otk-composer-feedback")).toHaveCSS(
          "position",
          "relative",
        );
        const transcript = await page.locator(".otk-messages").boundingBox();
        const dock = await page.locator(".otk-composer-dock").boundingBox();
        expect(transcript!.y + transcript!.height).toBe(dock!.y);
        const choiceBox = await choice.boundingBox();
        const inputBox = await page.locator(".otk-composer-input")
          .boundingBox();
        expect(choiceBox!.y + choiceBox!.height).toBeLessThanOrEqual(
          inputBox!.y,
        );
        for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
          await state.product("prefs.set", { key: "theme", value: theme });
          await expect(page.locator("html")).toHaveAttribute(
            "data-otk-theme",
            theme,
          );
          await info.attach(`send-choice-${theme}`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
        }
        await choice.getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect(choice).toHaveCount(0);
        await expect.soft(
          page.getByText("OTK has no further details", { exact: true }),
        ).toHaveCount(0);
        await expect.soft(page.locator(".otk-global-error")).toHaveCount(0);
        await expect.soft(page.locator(".otk-toast")).toHaveCount(0);
        expect.soft(
          await page.locator(".otk-session-view").evaluate((el) =>
            el.getBoundingClientRect().top
          ),
        ).toBe(top);
        await storage(false);
        await group.getByRole("button", {
          name: "Restore conversation",
          exact: true,
        }).click();
        await expect(group).toHaveCount(0);
        await state.native(`/session/${source.id}/revert`, "POST", {
          messageID: boundary,
          files: false,
        });
        await expect(group).toHaveAttribute("data-phase", "saved");
        await expect(
          page.getByText("OTK has no further details", { exact: true }),
        ).toHaveCount(0);
        return;
      }
      await scrollTranscript(page, true);
      await expect(group).toHaveAttribute("data-phase", "saved");
      if (contract === "dismiss") {
        await group.getByRole("button", { name: "Dismiss revert", exact: true })
          .click();
        await expect(group).toHaveAttribute("data-dismissed", "true");
        await expect(group.locator(".otk-revert-records")).toHaveCount(0);
      } else {
        await group.getByRole("button", {
          name: "Restore conversation",
          exact: true,
        }).click();
        await expect(group).toHaveCount(0);
        await scrollTranscript(page, true);
        await expect(page.locator(".otk-messages")).toContainText(
          "Reply to " + boundaryText,
          { timeout: 10_000 },
        );
      }
      await expect(page.locator(".otk-messages .otk-composer-notice-row"))
        .toHaveCount(0);
      await expect(
        page.locator(".otk-messages").getByRole("button", {
          name: "Saved earlier branches",
          exact: true,
        }),
      ).toHaveCount(0);
    },
  );
}
