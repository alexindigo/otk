// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { join } from "node:path";
test.use({ profile: "contract-typed-forms" });
test(
  "attention.typed-forms-all-fields-conditional-hidden-external-review-and-rejected-draft",
  { tag: ["@attention", "@forms", "@isolated"] },
  async ({ page, isolatedState: state }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSession(state, page, "tstv1-forms");
    const dock = page.locator('[data-form="typed-session"]');
    await expect(dock).toBeVisible();
    await expect(dock.getByRole("button", { name: "Review answers" }))
      .toBeDisabled();
    await expect(dock.getByRole("button", { name: "Review answers" }))
      .toHaveAttribute("aria-description", "An answer is required.");
    await dock.getByRole("textbox", { name: "Deployment name", exact: true })
      .fill("release");
    await dock.getByRole("textbox", { name: "Traffic fraction" }).fill("0.25");
    await dock.getByRole("textbox", { name: "Instances" }).fill("2");
    const mode = dock.locator('[data-field="mode"]');
    await mode.getByPlaceholder("Your answer...").fill("my custom schedule");
    await mode.getByRole("button", { name: "Deploy now", exact: true }).click();
    await expect(mode.getByPlaceholder("Your answer...")).toHaveValue(
      "my custom schedule",
    );
    await mode.getByText("Type your own answer", { exact: true }).click();
    await expect(mode.getByRole("button", { name: "Type your own answer" }))
      .toHaveAttribute("aria-pressed", "true");
    await mode.getByRole("button", { name: "Deploy now", exact: true }).click();
    const enabled = dock.getByRole("switch", {
      name: "Enable deployment",
      exact: true,
    });
    await enabled.check();
    await expect(enabled).toBeChecked();
    await expect(dock.getByRole("textbox", { name: "Release note" }))
      .toBeVisible();
    await dock.getByRole("textbox", { name: "Release note" }).fill(
      "Keep this private draft",
    );
    await enabled.uncheck();
    await expect(enabled).not.toBeChecked();
    await expect(dock.getByRole("textbox", { name: "Release note" }))
      .toHaveCount(0);
    await dock.getByRole("button", { name: "West region", exact: true })
      .click();
    await dock.getByRole("textbox", { name: "Custom value" }).fill(
      "custom-region",
    );
    await dock.getByRole("button", { name: "Add value", exact: true }).click();
    await dock.getByRole("button", { name: "Override value" }).click();
    await dock.getByRole("textbox", { name: "Environment", exact: true }).fill(
      "production",
    );
    await expect(dock.getByRole("link", { name: "Open external step" }))
      .toHaveAttribute("rel", "noopener noreferrer");
    await page.context().route(
      "https://example.com/**",
      (route) =>
        route.fulfill({
          body: "External step fixture",
          contentType: "text/plain",
        }),
    );
    const opened = page.waitForEvent("popup");
    await dock.getByRole("link", { name: "Open external step" }).click();
    await (await opened).close();
    await expect(dock.getByRole("button", { name: "Review answers" }))
      .toBeDisabled();
    await expect(dock.getByRole("button", { name: "Review answers" }))
      .toHaveAttribute(
        "aria-description",
        "Confirm that the external step is complete.",
      );
    await dock.getByRole("switch", {
      name: "I completed this step",
      exact: true,
    }).check();
    await expect(
      dock.locator('[data-field="regions"] .otk-task-marker.is-done'),
    ).toHaveCount(2);
    await expect(mode.locator(".otk-task-marker")).toHaveCount(0);
    const geometry = await dock.evaluate((element) => {
      const fields = Array.from(
        element.querySelectorAll<HTMLElement>(".otk-form-control"),
      );
      const labels = Array.from(
        element.querySelectorAll<HTMLElement>(".otk-form-label"),
      );
      const lefts = fields.map((field) => field.getBoundingClientRect().left);
      return {
        spread: Math.max(...lefts) - Math.min(...lefts),
        wrapping: labels.filter((label) =>
          label.scrollHeight > label.clientHeight + 1
        ).length,
      };
    });
    expect(geometry.spread).toBeLessThan(1);
    expect(geometry.wrapping).toBe(0);
    await expect(dock.locator("[disabled]")).toHaveCount(0);
    const controls = await dock.evaluate((element) => {
      const own = getComputedStyle(
        element.querySelector<HTMLTextAreaElement>(
          '[aria-label="Custom answer"]',
        )!,
      );
      const remove = element.querySelector<HTMLElement>(
        '[aria-label="Remove custom-region"]',
      )!;
      const button = remove.getBoundingClientRect(),
        icon = remove.querySelector("svg")!.getBoundingClientRect();
      return {
        background: own.backgroundColor,
        border: own.borderTopStyle,
        gaps: [
          icon.left - button.left,
          button.right - icon.right,
          icon.top - button.top,
          button.bottom - icon.bottom,
        ],
      };
    });
    expect(controls.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(controls.border).not.toBe("none");
    expect(Math.max(...controls.gaps) - Math.min(...controls.gaps))
      .toBeLessThanOrEqual(1);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      let footerTop: number | undefined;
      for (const edge of ["top", "bottom"]) {
        const bounds = await dock.evaluate((element, edge) => {
          const body = element.querySelector<HTMLElement>(".otk-surface-body")!;
          body.scrollTop = edge === "top" ? 0 : body.scrollHeight;
          const box = element.getBoundingClientRect(),
            footer = element.querySelector("footer")!.getBoundingClientRect(),
            content = body.getBoundingClientRect();
          return {
            top: box.top,
            bottom: box.bottom,
            footerTop: footer.top,
            footerBottom: footer.bottom,
            contentBottom: content.bottom,
            overflow: body.scrollHeight - body.clientHeight,
            clientHeight: body.clientHeight,
            scroll: body.scrollTop,
            documentHeight: document.documentElement.scrollHeight,
          };
        }, edge);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(800);
        expect(bounds.documentHeight).toBeLessThanOrEqual(800);
        expect(bounds.overflow).toBeGreaterThan(0);
        // Top and bottom viewport captures must together cover every field.
        expect(bounds.overflow).toBeLessThanOrEqual(bounds.clientHeight);
        expect(bounds.footerBottom).toBeLessThanOrEqual(bounds.bottom);
        expect(bounds.contentBottom).toBeLessThanOrEqual(bounds.footerTop + 1);
        if (edge === "top") {
          expect(bounds.scroll).toBe(0);
          footerTop = bounds.footerTop;
        } else {
          expect(bounds.scroll).toBeGreaterThan(0);
          expect(Math.abs(bounds.footerTop - footerTop!)).toBeLessThan(1);
        }
        await expect(dock.getByRole("button", { name: "Review answers" }))
          .toBeInViewport();
        await expect(
          dock.getByRole("button", { name: "Decline with feedback" }),
        ).toBeInViewport();
        await expect(dock.getByRole("button", { name: "Cancel execution" }))
          .toBeInViewport();
        if (process.env.OTK_V3_SCREENSHOTS) {
          console.log(JSON.stringify({ theme, edge, bounds }));
          await page.screenshot({
            path: join(
              process.env.OTK_V3_SCREENSHOTS,
              `${process.env.OTK_V3_STAMP}-${theme}-all-form-fields-${edge}.png`,
            ),
            fullPage: true,
          });
        }
      }
    }
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "fail",
    });
    await dock.getByRole("button", { name: "Review answers" }).click();
    await expect(dock.locator("dl")).toContainText('"production"');
    await expect(dock.locator("dl")).not.toContainText("conditional");
    await dock.getByRole("button", { name: "Send answers", exact: true })
      .click();
    await expect(dock.getByRole("button", { name: "Edit answers" }))
      .toBeVisible();
    await dock.getByRole("button", { name: "Edit answers" }).click();
    await expect(
      dock.getByRole("textbox", { name: "Deployment name", exact: true }),
    ).toHaveValue("release");
    await dock.getByRole("button", { name: "Review answers" }).click();
    await dock.getByRole("button", { name: "Send answers", exact: true })
      .click();
    await expect(dock).toHaveCount(0);
    const observed = await state.observe<{ received: unknown[] }>();
    expect(observed.received).toEqual(
      Array.from(
        { length: 2 },
        () => ({
          name: "release",
          mode: "now",
          rate: .25,
          count: 2,
          enabled: false,
          regions: ["west", "custom-region"],
          hidden: "production",
          external: true,
        }),
      ),
    );
  },
);
test(
  "attention.global-form-has-project-attention-and-dock-without-a-fake-session-after-reload",
  { tag: ["@attention", "@forms", "@isolated"] },
  async ({ page, isolatedState: state }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
    });
    await state.product("projects.inactive", {
      directory: state.directory,
      inactive: true,
    });
    await page.goto(state.url);
    const dock = page.locator('[data-form="typed-global"]');
    await expect(dock).toBeVisible();
    await expect(dock).toHaveAttribute("data-form-owner", "location");
    await expect(page.locator('[data-project][data-rollup="blocked"]').first())
      .toBeVisible();
    await page.reload();
    await expect(dock).toBeVisible();
    expect(await page.locator('[data-session="opcv2-global"]').count()).toBe(0);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      if (process.env.OTK_V3_SCREENSHOTS) {
        await page.screenshot({
          path: join(
            process.env.OTK_V3_SCREENSHOTS,
            `${process.env.OTK_V3_STAMP}-${theme}-global-form-dock.png`,
          ),
          fullPage: true,
        });
      }
    }
    await page.getByRole("button", { name: "Collapse projects", exact: true })
      .click();
    await expect(dock).toBeVisible();
    await expect(page.locator('[data-project][data-rollup="blocked"]').first())
      .toBeVisible();
    await dock.getByRole("switch", { name: "I completed this step" }).check();
    await dock.getByRole("button", { name: "Review answers" }).click();
    await dock.getByRole("button", { name: "Send answers" }).click();
    await expect(dock).toHaveCount(0);
    expect((await state.observe<{ received: unknown[] }>()).received).toEqual([{
      account: "Project account",
      verify: true,
    }]);
  },
);
