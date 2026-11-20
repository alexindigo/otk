// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({
  profile: "contract-visual-styles",
  timezoneId: "America/Los_Angeles",
});

test("visual.failure-layout-shares-placement-disclosure-and-metadata", {
  tag: ["@visual", "@isolated", "@messages"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    for (
      const surface of ["main", "interval", "reconnect", "settings", "footer"]
    ) {
      const scene = surface === "main" ? "error-surfaces" : "failure-layout";
      await page.goto(`${state.url}/?scene=${scene}&surface=${surface}`);
      await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
      await page.evaluate((theme) => {
        const driver = globalThis as unknown as {
          styleTest: { theme(id: string): void };
        };
        driver.styleTest.theme(theme);
      }, theme);
      await page.evaluate(() => document.fonts.ready);
      await expect(
        page.locator(
          ".otk-failure-content details, .otk-failure-content summary",
        ),
      ).toHaveCount(0);
      const overflow = await page.locator(".otk-failure-content").evaluateAll((
        elements,
      ) => elements.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
      expect(overflow).toBe(0);
      for (const failure of await page.locator(".otk-failure-content").all()) {
        const edges = await failure.evaluate((el) =>
          [...el.querySelectorAll(
            ".otk-failure-heading, .otk-failure-main-reason, .otk-failure-action",
          )].filter((node) => node.getClientRects().length).map((node) =>
            node.getBoundingClientRect().left
          )
        );
        await expect(failure.locator("[aria-expanded]")).toHaveCount(1);
        await expect(failure.locator(".otk-tree-node, .otk-tree-connector"))
          .toHaveCount(0);
        if (edges.length > 1) {
          expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(
            1,
          );
        }
      }
      if (surface === "main") {
        await expect(page.locator('[data-tool="bash"] .otk-failure-heading'))
          .toHaveCount(0);
        await expect(page.locator(".otk-prompt-chip .otk-failure-content"))
          .toHaveCount(0);
        await expect(
          page.locator(".otk-prompt-attachments .otk-failure-heading"),
        ).toHaveCount(1);
        await expect(
          page.locator(".otk-prompt-attachments .otk-failure-target"),
        )
          .toHaveText("unreadable-attachment.txt");
        await expect(page.locator(".otk-prompt-chip.has-error")).toHaveCount(1);
        await expect(page.locator(".otk-prompt-chip:not(.has-error)"))
          .toHaveText("readable-notes.txt");
        await expect(
          page.locator(".otk-prompt-attachments .otk-failure-reason:visible"),
        ).toHaveText("The attachment could not be read");
        await expect(
          page.locator(".otk-operation-feedback .otk-composer-notice-icon"),
        ).toHaveCount(0);
        await expect(page.locator(".otk-toast .otk-failure-signal"))
          .toHaveCount(0);
        const toastEdges = await page.locator(
          ".otk-toast-title, .otk-toast .otk-failure-heading",
        ).evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().left)
        );
        expect(toastEdges).toHaveLength(2);
        expect(Math.max(...toastEdges) - Math.min(...toastEdges))
          .toBeLessThanOrEqual(1);
        const failure = page.locator(".otk-inbox-footer .otk-failure-details");
        const toggle = failure;
        await toggle.press("ArrowRight");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(
          page.locator(".otk-inbox-footer .otk-failure-reason:visible"),
        )
          .toBeVisible();
        await toggle.press("ArrowLeft");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
      }
      if (surface === "interval") {
        await expect(page.locator(".otk-record-group-failures")).toHaveText(
          "2 failed",
        );
        await expect(page.locator(".otk-record-group-heading").first())
          .toHaveText("1 permission·2 failed");
        await expect(page.locator(".otk-native-record .otk-failure-heading"))
          .toHaveCount(0);
        await expect(page.locator(".otk-tool-brief")).toHaveCount(0);
        await expect(page.locator(".otk-failure-reason:visible")).toHaveCount(
          2,
        );
        const colors = await page.locator(".otk-record-group-failures")
          .evaluate((el) => ({
            actual: getComputedStyle(el).color,
            meta: getComputedStyle(
              el.closest(".otk-record-group-heading")!.querySelector(
                ".otk-chrome-meta",
              )!,
            ).color,
          }));
        expect(colors.actual).not.toBe(colors.meta);
      }
      if (surface === "reconnect") {
        const geometry = await page.locator(".otk-server-connection").evaluate(
          (el) => {
            const label = el.querySelector(".otk-server-label")!,
              status = el.querySelector(".otk-connection-status")!;
            return {
              label: (() => {
                const range = document.createRange();
                range.selectNodeContents(label);
                return range.getBoundingClientRect().left;
              })(),
              status: status.getBoundingClientRect().left,
              labelColor: getComputedStyle(label).color,
              statusColor: getComputedStyle(status).color,
            };
          },
        );
        expect(Math.abs(geometry.label - geometry.status)).toBeLessThanOrEqual(
          1,
        );
        expect(geometry.labelColor).toBe(geometry.statusColor);
      }
      if (surface === "settings") {
        await expect(page.getByText("This server", { exact: true }))
          .toHaveCount(1);
        await expect(page.getByText("Reconnecting to OTK...", { exact: true }))
          .toHaveCount(1);
        await expect(
          page.getByText("Agent service reconnecting", { exact: true }),
        ).toHaveCount(0);
        await expect(page.getByText("reconnecting", { exact: true }))
          .toHaveCount(0);
      }
      if (surface === "footer") {
        await expect(
          page.locator(
            '.otk-message[data-message="reply"] .otk-failure-reason:visible',
          ),
        ).toHaveCount(1);
        await expect(page.locator(".otk-failure-time")).toHaveCount(0);
        await expect(page.locator(".otk-message-footer time")).toHaveText([
          "1:16 AM",
          "1:23 AM",
        ]);
        await expect(page.getByText("No time recorded", { exact: true }))
          .toBeVisible();
      }
    }
  }
});
