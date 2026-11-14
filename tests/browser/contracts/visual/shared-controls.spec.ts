// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-messages-public-ui" });
const tags = { tag: ["@visual", "@isolated"] };
test(
  "visual.shared-file-collections-disclose-exact-source-and-counts",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.goto(state.url + "/?shared-controls");
    const toggles = page.locator("[data-diffs] .otk-tool-toggle");
    await expect(toggles).toHaveCount(2);
    for (const toggle of await toggles.all()) {
      await expect(toggle)
        .toHaveAttribute("aria-expanded", "false");
    }
    for (const tool of ["edit", "patch"]) {
      await page.locator(`[data-diffs] [data-tool=${tool}] .otk-tool-toggle`)
        .click();
      await expect(
        page.locator(`[data-diffs] [data-tool=${tool}] .otk-tool-body`),
      ).toBeVisible();
    }
    const values = await page.locator("[data-diffs] .otk-diff").evaluateAll(
      (els) =>
        els.map(
          (el) => [
            el.getAttribute("aria-label"),
            !!el.querySelector("header"),
            Array.from(el.querySelectorAll(".otk-diff-text")).map((x) =>
              x.textContent
            ).join("|"),
          ],
        ),
    );
    expect(values).toEqual([["Modified a.ts", false, "old|new"], [
      "Modified a.ts",
      false,
      "old|new",
    ]]);
    expect(
      await toggles.evaluateAll((els) =>
        els.every((el) =>
          el.textContent!.includes("+1") && el.textContent!.includes("\u22121")
        )
      ),
    ).toBe(true);
  },
);
test(
  "visual.shared-native-preference-rejections-and-contributed-groups",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.goto(state.url + "/?shared-controls");
    await expect(page.locator(".otk-visual-settings input").first())
      .toBeVisible();
    for (
      const selector of [
        ".otk-visual-settings input[name=reducedColors]",
        '.otk-notification-settings input[name="notify.sound"]',
      ]
    ) {
      await page.locator(selector).click();
      await expect(page.locator("[data-pending]")).toHaveText("1");
      await page.locator("[data-reject]").click();
      await expect(page.locator("[data-pending]")).toHaveText("0");
      await expect(page.locator(selector)).not.toBeChecked();
    }
    await page.locator("[data-display] button").click();
    const select = page.locator(
      ".otk-display-preferences select[name=diffStyle]",
    );
    await select.selectOption("split");
    await expect(page.locator("[data-pending]")).toHaveText("1");
    await page.locator("[data-reject]").click();
    await expect(page.locator("[data-pending]")).toHaveText("0");
    await expect(select).toHaveValue("auto");
    await page.keyboard.press("Escape");
    await expect(
      page.locator('.otk-visual-settings input[name="consumer.appearance"]'),
    ).toBeAttached();
    await expect(
      page.locator(
        '.otk-notification-settings input[name="consumer.notification"]',
      ),
    ).toBeAttached();
    await page.locator("[data-broadcast]").click();
    await expect(page.locator(".otk-visual-settings input[name=reducedColors]"))
      .toBeChecked();
    const sound = page.locator(
      '.otk-notification-settings input[name="notify.sound"]',
    );
    await expect(sound).toBeChecked();
    await sound.click();
    await expect(page.locator("[data-pending]")).toHaveText("1");
    await page.locator("[data-broadcast]").click();
    await page.locator("[data-reject]").click();
    await expect(sound).toBeChecked();
  },
);
test(
  "visual.shared-preferences-authoritative-pending-unready-intent-and-injection",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.goto(state.url + "/?shared-controls");
    const field = page.locator(
      '.otk-visual-settings input[name="consumer.appearance"]',
    );
    await field.click();
    await expect(page.locator("[data-pending]")).toHaveText("1");
    await expect(field).not.toBeChecked();
    await page.locator("[data-accept]").click();
    await expect(field).toBeChecked();
    await page.locator("[data-ready]").click();
    const calls = await page.locator("[data-calls]").textContent();
    await field.click();
    await expect(page.locator(".otk-visual-settings [role=alert]")).toHaveText(
      /OTK has no further details/,
    );
    await expect(field).toBeChecked();
    await expect(page.locator("[data-calls]")).toHaveText(calls!);
    await expect(page.locator(".otk-visual-settings :disabled")).toHaveCount(0);
  },
);
test(
  "visual.auth-conditional-captured-credentials-and-rejected-save",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.goto(state.url + "/?layout-controls");
    await page.locator("input[name=username]").fill("Retained user");
    await page.locator("input[name=password]").fill("Retained password");
    await page.locator("select[name=type]").selectOption("none");
    await expect(page.locator("[data-auth-pane] input[name=username]"))
      .toHaveCount(0);
    await page.locator("[data-auth-pane] button[type=submit]").click();
    await expect(page.locator("[data-payload]")).toContainText("none");
    expect(JSON.parse((await page.locator("[data-payload]").textContent())!))
      .toEqual({ type: "none", username: "", password: "" });
    await page.locator("[data-reject]").click();
    await expect(page.locator("[data-auth-pane] form[aria-busy=true]"))
      .toHaveCount(0);
    await page.locator("select[name=type]").selectOption("password");
    await expect(page.locator("input[name=username]")).toHaveValue(
      "Retained user",
    );
    await expect(page.locator("input[name=password]")).toHaveValue(
      "Retained password",
    );
  },
);
test(
  "visual.independent-diff-auto-measures-own-container",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.goto(state.url + "/?layout-controls");
    const diff = page.locator("[data-independent-diff] .otk-diff");
    await expect(diff).toHaveAttribute("data-diff-style", "unified");
    expect((await diff.boundingBox())!.width).toBe(800);
    await page.locator("[data-wide-diff]").click();
    await expect(diff).toHaveAttribute("data-diff-style", "split");
    expect((await diff.boundingBox())!.width).toBe(1300);
  },
);
test(
  "visual.required-chip-editor-node-focus-each-character-resize-and-rejection",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.goto(state.url + "/?layout-tabs");
    await page.locator("[data-theme-dark]").click();
    await page.locator("[data-edit-chip]").click();
    const input = page.getByRole("textbox", {
      name: "Rename session",
      exact: true,
    });
    await expect(input).toBeVisible();
    const original = await input.elementHandle();
    await input.click();
    await page.keyboard.press("Control+a");
    const text = "abcdefghijklmnopqrstuvwxyz1234";
    for (let i = 0; i < text.length; i++) {
      await page.keyboard.insertText(text[i]);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(text.slice(0, i + 1));
      expect(await input.evaluate((el, old) => el === old, original)).toBe(
        true,
      );
    }
    for (const width of [600, 800, 1280, 1920, 600]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(text);
      expect(await input.evaluate((el, old) => el === old, original)).toBe(
        true,
      );
      await expect(page.locator('[data-crumb="tstv1-independent-6"]'))
        .toBeVisible();
      const g = await input.evaluate((el) => {
        const row = document.querySelector(".otk-breadcrumb-row")!,
          r = row.getBoundingClientRect(),
          i = el.getBoundingClientRect(),
          feedback = document.getElementById(
            el.getAttribute("aria-describedby")!,
          )!,
          f = feedback.getBoundingClientRect();
        return {
          inside: i.top >= r.top - 1 && i.bottom <= r.bottom + 1,
          feedbackVisible: f.top >= r.bottom - 1 && f.height >= 20,
        };
      });
      expect(g.inside && g.feedbackVisible).toBe(true);
    }
    await page.keyboard.press("Enter");
    await expect(input).toHaveAttribute("readonly", "");
    await page.locator("[data-reject-chip]").evaluate((el) =>
      (el as HTMLElement).click()
    );
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(input).toHaveValue(text);
    expect(
      await page.getByRole("alert").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          ?.closest("[role=alert]") === el;
      }),
    ).toBe(true);
  },
);
