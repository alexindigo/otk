// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({
  profile: "contract-visual-styles",
  timezoneId: "America/Los_Angeles",
});

test("visual.record-tree-content-gutter-preserves-both-artwork-axes", {
  tag: ["@visual", "@isolated", "@messages"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await page.goto(`${state.url}/?scene=uiconv&surface=record-tree`);
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
    await page.evaluate(
      (theme) =>
        (globalThis as unknown as { styleTest: { theme(id: string): void } })
          .styleTest.theme(theme),
      theme,
    );
    for (const record of await page.locator(".otk-native-record").all()) {
      await record.locator(".otk-tool-toggle").press("ArrowRight");
      const axes = await record.evaluate((el) => {
        const art = el.querySelector(".otk-tree-icon-art")!
          .getBoundingClientRect();
        const guide = el.querySelector(".otk-tree-incoming")!
          .getBoundingClientRect();
        return { art: art.x + art.width / 2, guide: guide.x + guide.width / 2 };
      });
      expect(
        Math.abs(axes.art - axes.guide),
        `${theme} ${await record.textContent()}`,
      ).toBeLessThanOrEqual(1);
    }
  }
});

test("visual.failure-layout-shares-placement-disclosure-and-metadata", {
  tag: ["@visual", "@isolated", "@messages"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    for (
      const surface of [
        "main",
        "interval",
        "reconnect",
        "settings",
        "footer",
        "send",
        "icons",
        "tree",
        "forms",
      ]
    ) {
      const scene = surface === "main"
        ? "error-surfaces"
        : ["send", "icons", "tree"].includes(surface)
        ? "uiconv"
        : surface === "forms"
        ? "forms"
        : "failure-layout";
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
          "details, summary, select",
        ),
      ).toHaveCount(0);
      const overflow = await page.locator(".otk-failure-content").evaluateAll((
        elements,
      ) => elements.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
      expect(overflow).toBe(0);
      for (
        const details of await page.locator(".otk-failure-details:visible")
          .all()
      ) {
        const trailing = await details.evaluate((el) => {
          const text = document.createRange();
          text.selectNodeContents(
            el.querySelector(".otk-failure-detail-toggle")!,
          );
          return el.getBoundingClientRect().right -
            text.getBoundingClientRect().right;
        });
        expect(trailing).toBeGreaterThan(1);
      }
      for (
        const connection of await page.locator(".otk-connection:visible").all()
      ) {
        const geometry = await connection.evaluate((el) => {
          const box = (selector: string) =>
            el.querySelector(selector)?.getBoundingClientRect();
          const lamp = box(".otk-connection-light"),
            details = box(".otk-disclosure-icon");
          const style = getComputedStyle(el);
          return {
            axes: lamp && details
              ? Math.abs(
                lamp.x + lamp.width / 2 - details.x - details.width / 2,
              )
              : 0,
            headings: Array.from(el.querySelectorAll(".otk-failure-heading"))
              .map((heading) =>
                Math.abs(
                  heading.getBoundingClientRect().left -
                    el.getBoundingClientRect().left -
                    parseFloat(style.gridTemplateColumns) -
                    parseFloat(style.columnGap),
                )
              ),
          };
        });
        expect(geometry.axes).toBeLessThanOrEqual(1);
        expect(geometry.headings.every((offset) => offset <= 1)).toBe(true);
      }
      for (const failure of await page.locator(".otk-failure-content").all()) {
        const edges = await failure.evaluate((el) =>
          Array.from(el.querySelectorAll(
            ".otk-failure-heading, .otk-failure-main-reason, .otk-failure-action, .otk-failure-detail-toggle",
          )).filter((node) => node.getClientRects().length).map((node) =>
            node.getBoundingClientRect().left
          )
        );
        const disclosure = failure.getByRole("button", {
          name: "Details",
          exact: true,
        });
        if (
          await failure.evaluate((el) => el.classList.contains("is-feedback"))
        ) {
          const more = failure.getByRole("button", { name: "More actions" });
          if (await more.isVisible()) {
            await more.click();
            await expect(
              page.getByRole("menuitem", { name: "Details", exact: true }),
            )
              .toHaveAttribute("aria-expanded", "false");
            await page.keyboard.press("Escape");
          } else {await expect(disclosure).toHaveAttribute(
              "aria-expanded",
              "false",
            );}
        } else await expect(failure.locator("[aria-expanded]")).toHaveCount(1);
        await expect(failure.locator(".otk-tree-node, .otk-tree-connector"))
          .toHaveCount(0);
        if (edges.length > 1) {
          expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(
            1,
          );
        }
      }
      for (
        const record of await page.locator(
          ".otk-tool-line:has(.otk-failure-content.is-record)",
        ).all()
      ) {
        const edges = await record.evaluate((el) => {
          const heading = Array.from(
            el.querySelector(".otk-tool-state")!.children,
          ).find((child) => !child.classList.contains("otk-tree-icon"))!;
          return [
            heading,
            el.querySelector(".otk-failure-main-reason")!,
            el.querySelector(".otk-failure-detail-toggle")!,
          ].map((node) => node.getBoundingClientRect().left);
        });
        expect(
          Math.max(...edges) - Math.min(...edges),
          `${surface}/${theme} record heading and failure edge`,
        ).toBeLessThanOrEqual(1);
      }
      for (
        const toggle of await page.locator(".otk-disclosure-toggle:visible")
          .all()
      ) {
        const gaps = await toggle.evaluate((el) => {
          const slot = el.querySelector(".otk-disclosure-icon")!
            .getBoundingClientRect();
          const icon = el.querySelector(".otk-disclosure-icon svg")!
            .getBoundingClientRect();
          return [
            icon.left - slot.left,
            slot.right - icon.right,
            icon.top - slot.top,
            slot.bottom - icon.bottom,
          ];
        });
        expect(
          Math.max(...gaps) - Math.min(...gaps),
          `${surface}/${theme} disclosure gaps`,
        ).toBeLessThanOrEqual(1);
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
        ).toHaveCount(1);
        await expect(
          page.locator(".otk-operation-feedback .otk-failure-signal"),
        ).toHaveCount(0);
        await expect(page.locator(".otk-toast .otk-failure-signal"))
          .toHaveCount(0);
        await expect(page.locator(".otk-toast .otk-failure-target"))
          .toHaveText("Error presentation review");
        const plain = page.locator('.otk-toast[data-note="ordinary-review"]');
        await expect(plain.locator(".otk-toast-lead, [data-signal]"))
          .toHaveCount(0);
        await expect(plain.locator(".otk-toast-title")).toHaveText(
          "Project saved",
        );
        const toastOffsets = await page.locator(
          ".otk-toast-title, .otk-toast .otk-failure-heading",
        ).evaluateAll((elements) =>
          elements.map((element) => {
            const row = element.closest(".otk-toast-row")!;
            const style = getComputedStyle(row);
            const track = element.matches(".otk-failure-heading")
              ? parseFloat(style.gridTemplateColumns) +
                parseFloat(style.columnGap)
              : 0;
            return element.getBoundingClientRect().left -
              row.getBoundingClientRect().left - track;
          })
        );
        expect(toastOffsets).toHaveLength(2);
        for (const offset of toastOffsets) {
          expect(Math.abs(offset)).toBeLessThanOrEqual(1);
        }
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
        await expect(page.locator(".otk-record-group-heading").first())
          .toHaveText("1 permission · 2 failed");
        await expect(page.locator(".otk-native-record .otk-failure-heading"))
          .toHaveCount(0);
        // WP3 moves the native record's brief into its own heading slot.
        // FailureContent must still not introduce a second heading/brief.
        await expect(page.locator(".otk-failure-content .otk-tool-brief"))
          .toHaveCount(0);
        await expect(page.locator(".otk-failure-reason:visible")).toHaveCount(
          2,
        );
        const colors = await page.locator(
          ".otk-record-group-heading .otk-chrome-meta",
        ).first()
          .evaluate((el) => {
            const canonical = document.createElement("span");
            canonical.className = "otk-chrome-meta";
            el.after(canonical);
            const result = {
              actual: getComputedStyle(el).color,
              meta: getComputedStyle(canonical).color,
              weight: getComputedStyle(el).fontWeight,
            };
            canonical.remove();
            return result;
          });
        expect(colors.actual).toBe(colors.meta);
        expect(colors.weight).toBe("400");
        const record = page.locator(".otk-native-record").first();
        await record.locator(".otk-tool-toggle").first().press("ArrowRight");
        await expect(record.locator("[data-record-time]")).toHaveAttribute(
          "datetime",
          "2026-11-20T09:23:00.000Z",
        );
        await expect(record.locator("[data-record-time]")).toHaveText(
          /Nov 20, 2026.*1:23:00\.000 AM PST/,
        );
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
        await expect(
          page.locator(
            "[data-role=assistant] .otk-message-footer time[title]:visible",
          ),
        ).toHaveText([
          "1:16 AM",
          "1:23 AM",
        ]);
        await expect(page.getByText("Time unknown", { exact: true }))
          .toBeVisible();
      }
      if (surface === "send") {
        const pending = page.locator('[data-message="unknown"]');
        await expect(pending.locator(".otk-failure-signal")).toHaveCount(0);
        await expect(pending.locator(".otk-failure-heading")).toHaveText(
          "Checking whether sending prompt finished",
        );
        await expect(page.locator(".otk-send-failure .otk-failure-target"))
          .toHaveCount(0);
        for (const message of await page.locator(".otk-user-message").all()) {
          const edge = await message.evaluate((el) => ({
            bubble:
              el.querySelector(".otk-user-bubble")!.getBoundingClientRect()
                .right,
            feedback:
              el.querySelector(".otk-send-failure")!.getBoundingClientRect()
                .right,
          }));
          expect(Math.abs(edge.bubble - edge.feedback)).toBeLessThanOrEqual(1);
        }
      }
      if (surface === "icons") {
        await expect(page.locator(".otk-tool-state .otk-tree-icon-art svg"))
          .toHaveCount(6);
        await expect(page.locator(".otk-todos .otk-state-shape")).toHaveCount(
          4,
        );
        await expect(
          page.locator(".otk-state-shape text, .otk-tree-icon-art text"),
        ).toHaveCount(0);
        await expect(
          page.getByText(
            "Loading messages... 1m 5s / Worked for 1m 5s / Live work 1m 5s",
          ),
        ).toBeVisible();
        await expect(page.locator("time").filter({ hasText: ".107" }))
          .toHaveText(/Nov 20, 2026.*1:23:00\.107 AM PST/);
      }
      if (surface === "tree") {
        const fills = await page.locator(".otk-tree-toggle rect").evaluateAll((
          elements,
        ) => elements.map((el) => getComputedStyle(el).fill));
        expect(fills.length).toBeGreaterThan(0);
        expect(fills.every((fill) => fill === "none")).toBe(true);
      }
      if (surface === "forms") {
        await page.getByRole("button", { name: "Kind: Alpha", exact: true })
          .click();
        await page.getByRole("button", { name: "Beta", exact: true }).press(
          "Enter",
        );
        await expect(
          page.getByRole("button", { name: "Kind: Beta", exact: true }),
        ).toBeFocused();
        await expect(page.locator("input[type=hidden][name=kind]")).toHaveValue(
          "beta",
        );
      }
    }
  }
});
