// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";
import { openLatestWork } from "../../pages/transcript.ts";

test.describe("neutral backend facts", () => {
  test.use({ profile: "contract-messages-facts" });
  test(
    "messages.neutral-backend-facts",
    { tag: ["@messages", "@contracts"] },
    async ({ isolatedState: state, page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${state.url}/#/local/tstv1-core`);
      await openLatestWork(page);
      await expect(page.locator(".otk-composer-agent:not([inert] *)"))
        .toHaveText("Action");
      await page.locator(".otk-agent-picker > button").click();
      await expect(
        page.locator(".otk-popover-panel:popover-open .otk-picker-name"),
      ).toHaveCount(4);
      await page.locator(
        '.otk-popover-panel:popover-open [data-picker-key="action"] .otk-picker-option',
      ).click();
      await expect(page.locator(".otk-agent-picker > button")).not.toHaveClass(
        /is-applied/,
      );
      const external = page.locator("[data-tool=external] .otk-tool-toggle");
      if (await external.getAttribute("aria-expanded") === "false") {
        await external.click();
      }
      await expect(external).toHaveAttribute("aria-expanded", "true");
      await page.locator(".otk-reply-start .otk-entity-pill").hover();
      const observed = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--accent)";
        document.body.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.style.color = "var(--otk-fg)";
        const foreground = getComputedStyle(probe).color;
        probe.remove();
        return {
          task: document.querySelector(
            "[data-tool=task] .otk-work-run-preview .otk-chrome-meta",
          )
            ?.textContent,
          notice: document.querySelector("[data-tool=external] small")
            ?.textContent,
          reply: getComputedStyle(
            document.querySelector(".otk-reply-start .otk-entity-pill")!,
          )
            .color,
          trigger: getComputedStyle(
            document.querySelector(".otk-agent-picker > button")!,
          ).color,
          accent,
          foreground,
        };
      });
      expect(observed.task).toBe("Unknown agent");
      expect(observed.notice).toBe("Output truncated.");
      expect(observed.reply).toBe(observed.foreground); // WP2 neutral entity surface.
      expect(observed.trigger).toBe(observed.accent);
      await page.locator(".otk-agent-picker > button").click();
      await expect(
        page.locator(".otk-popover-panel:popover-open .otk-picker-name"),
      ).toHaveCount(4);
      const rows = await page.locator(
        ".otk-popover-panel:popover-open .otk-picker-name",
      ).evaluateAll((elements) => {
        const values = ["var(--accent)", "var(--secondary)", "#12abEF"];
        return elements.slice(0, 3).map((element, index) => {
          const probe = document.createElement("span");
          probe.style.color = values[index];
          document.body.append(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          return { expected, actual: getComputedStyle(element).color };
        });
      });
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row.actual).toBe(row.expected);
      await page.keyboard.press("Escape");
      await expect(
        page.locator(".otk-agent-picker .otk-popover-panel:popover-open"),
      ).toHaveCount(0);
    },
  );
});

test.describe("honest native metadata", () => {
  test.use({ profile: "contract-messages-metadata" });
  test("messages.unknown-metadata-output-draft", {
    tag: ["@messages", "@contracts", "@composer"],
  }, async ({ isolatedState: state, page }) => {
    const frames = await wire(page);
    await page.goto(`${state.url}/#/local/tstv1-core`);
    const work = await openLatestWork(page);
    await work.getByRole("button", { name: "Search 2 searches", exact: true })
      .click();
    await expect(work.locator("[data-tool=search]")).toHaveCount(2);
    const rows = await work.locator("[data-tool=search] .otk-tool-toggle")
      .allTextContents();
    expect(rows[0]).not.toContain("0 matches");
    expect(rows[0]).not.toContain("*");
    expect(rows[1]).toContain("0 matches");
    const patch = page.locator("[data-tool=patch] .otk-tool-toggle");
    await patch.click();
    await expect(page.locator("[data-tool=patch] .otk-diff")).toHaveAttribute(
      "aria-label",
      "Change Path not reported",
    );
    await expect(
      work.locator("[data-tool=patch] .otk-work-run-preview > .otk-chrome-meta")
        .first(),
    ).toHaveText(
      "Path not reported",
    );
    await patch.click({ button: "right" });
    await expect(page.locator(":popover-open [role=menu]")).toBeVisible();
    await expect(
      page.locator(':popover-open [data-context-command="tool.copy.path"]'),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.locator("[data-tool=external] .otk-tool-toggle").click();
    const count = () =>
      page.locator("[data-tool=external] pre").evaluate((element) =>
        element.textContent!.split("\n").length
      );
    expect(await count()).toBe(15);
    await expect(page.locator("[data-tool=external] .otk-output-toggle"))
      .toHaveCount(0);
    await page.locator("textarea[name=prompt]").fill("Keep this unsent draft");
    await page.locator(".otk-prompt").evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(20 * 1024 * 1024 + 1)], "too-large.bin", {
          type: "application/octet-stream",
        }),
      );
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: data }),
      );
    });
    const chip = page.locator(".otk-prompt-chip");
    await expect(chip).toHaveClass(/has-error/);
    const feedbackID = await chip.locator("button.otk-control-grow")
      .getAttribute("aria-describedby");
    expect(feedbackID).toBeTruthy();
    await expect(page.locator(`[id=${JSON.stringify(feedbackID)}]`))
      .toContainText(
        "Each upload must be 20 MiB or smaller",
      );
    await expect(page.locator("textarea[name=prompt]")).toHaveValue(
      /Keep this unsent draft/,
    );
    expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
      .toHaveLength(0);
  });
});
