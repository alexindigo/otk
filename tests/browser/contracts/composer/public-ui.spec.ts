// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { selectionMarks } from "../../pages/selection-marks.ts";

test.use({ profile: "contract-messages-public-ui" });
test(
  "composer.public-ui-secondary-failure-keeps-successful-send-and-separate-feedback",
  { tag: ["@composer", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    await page.goto(`${state.url}/?secondary-failures`);
    await page.locator("[data-dark]").click();
    await page.locator(".otk-prompt textarea").fill("Submit exactly once");
    await page.locator(".otk-send-button").click();
    await expect(page.locator("[data-sent]")).toHaveText("1");
    await expect(page.locator(".otk-prompt textarea")).toHaveValue("");
    await expect(page.locator("[data-bookkeeping]")).toContainText(
      "Visit storage unavailable",
    );
    await expect(page.locator(".otk-prompt [role=alert]")).toHaveCount(0);
  },
);
test("composer.public-ui-sync-async-paste-drop-refusals-retain-input", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(`${state.url}/?interaction-failures`);
  await page.locator("[data-dark]").click();
  await page.locator(".otk-prompt textarea").fill("Retain this unsent input");
  for (const mode of ["sync", "async"]) {
    for (const kind of ["paste", "drop"]) {
      await page.locator(`[data-${mode}]`).click();
      await page.evaluate((kind) => {
        document.querySelector(
          kind === "paste" ? ".otk-prompt textarea" : ".otk-prompt",
        )!.dispatchEvent(
          kind === "paste"
            ? new ClipboardEvent("paste", { bubbles: true, cancelable: true })
            : new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: new DataTransfer(),
            }),
        );
      }, kind);
      await expect(
        page.locator(".otk-prompt [role=alert] .otk-failure-content"),
      )
        .toHaveText(/OTK has no further details/);
      await expect(page.locator(".otk-prompt textarea")).toHaveValue(
        "Retain this unsent input",
      );
    }
  }
});
test(
  "composer.public-ui-completion-native-keyboard-pointer-and-selection-geometry",
  { tag: ["@composer", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    await page.goto(`${state.url}/?shared-controls`);
    const input = page.locator("textarea[name=prompt]");
    await input.fill("@");
    const options = page.locator(".otk-autocomplete button");
    await expect(options).toHaveCount(2);
    const geometry = await selectionMarks(page, ".otk-autocomplete button");
    expect(geometry).toHaveLength(2);
    for (const mark of geometry) {
      expect([mark.orientation, mark.width, mark.markHeight, mark.shift])
        .toEqual(["vertical", 3, 14, 0]);
      expect(mark.centred).toBeLessThan(.5);
    }
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(input).toHaveValue("Second option");
    await input.fill("@");
    await expect(options).toHaveCount(2);
    await options.first().click();
    await expect(input).toHaveValue("First option");
    await input.press("Escape");
    await input.fill("");
  },
);
