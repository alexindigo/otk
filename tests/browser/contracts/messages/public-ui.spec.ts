// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-messages-public-ui" });
test("messages.public-ui-external-tools-callbacks-isolation", {
  tag: ["@messages", "@contracts", "@composer"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url);
  await expect(page.locator("#registered .otk-tool-toggle")).toHaveCount(2);
  await expect(page.locator("#registered [data-external-tool]")).toHaveCount(0);
  await page.locator("#registered > .otk-tool-line .otk-tool-toggle").click();
  await page.locator("#registered .otk-message .otk-tool-toggle").click();
  await expect(page.locator("#registered [data-external-tool]")).toHaveCount(2);
  await expect(page.locator("[data-library-code] .otk-token").first())
    .toBeAttached();
  await expect(page.locator("[data-library-code] code")).toHaveJSProperty(
    "textContent",
    "const externalResult: number = 7;",
  );
  const token = page.locator("[data-library-code] .otk-token").first(),
    dark = await token.evaluate((e) => getComputedStyle(e).color);
  await page.locator("[data-light]").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-otk-theme",
    "otk-light",
  );
  await expect.poll(() => token.evaluate((e) => getComputedStyle(e).color)).not
    .toBe(dark);
  await page.locator("[data-dark]").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-otk-theme",
    "otk-dark",
  );
  await expect.poll(() => token.evaluate((e) => getComputedStyle(e).color))
    .toBe(dark);
  await expect(page.locator("#isolated [data-external-tool]")).toHaveCount(0);
  await expect(page.locator("#isolated .otk-tool-toggle")).toContainText(
    "external-probe Initial result",
  );
  await expect(page.locator("#isolated .otk-tool-verb")).toHaveText(
    "external-probe",
  );
  await expect(page.locator("#isolated .otk-tool-brief")).toHaveText(
    "Initial result",
  );
  await page.locator("#isolated .otk-tool-toggle").click();
  await expect(page.locator("#isolated .otk-tool-body")).toBeVisible();
  await expect(page.locator("#isolated .otk-tool-output")).toHaveText(
    "Reusable output",
  );
  await expect(page.locator("#isolated .otk-tool-body .otk-tool-summary"))
    .toHaveCount(0);
  await page.locator("[data-update]").click();
  await expect(page.locator("#registered .otk-tool-toggle").first())
    .toContainText("Inspect");
  await expect(page.locator("#registered .otk-tool-toggle").first())
    .toContainText("external target");
  await expect(page.locator("#registered .otk-tool-body").first())
    .toBeVisible();
  await expect.poll(() =>
    page.locator("[data-external-tool] .otk-tool-summary").evaluateAll((rows) =>
      rows.every((e) => e.textContent!.includes("Updated result"))
    )
  ).toBe(true);
  await page.locator("[data-open]").first().click();
  await expect(page.locator("#opened")).toHaveText("child-probe");
  await expect(page.locator("[data-external-part]")).toHaveText(
    "Injected part: agent",
  );
  await expect(page.locator("[data-typed-part]")).toHaveText(
    "Feature part: Updated result",
  );
  await expect(page.locator("#registered")).toContainText(
    "Unsupported part: future.card",
  );
  await page.locator("[data-inject]").click();
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Injected draft",
  );
  await expect(page.locator(".otk-prompt-context > span").first()).toHaveText(
    "External-Agent",
  );
  await page.locator("textarea[name=prompt]").click();
  await expect(page.locator("textarea[name=prompt]")).toBeFocused();
  expect(
    await page.locator("textarea[name=prompt]").evaluate((e) =>
      e.closest(".otk-composer") === null
    ),
  ).toBe(true);
  await expect(page.locator("textarea[name=prompt]")).toHaveCSS(
    "outline-style",
    "solid",
  );
  await page.locator(".otk-prompt button[type=submit]").click();
  await expect(page.locator("textarea[name=prompt]")).toHaveValue("");
  await expect.poll(() =>
    page.locator("#submitted").textContent().then((s) => JSON.parse(s!))
  ).toEqual([{ kind: "text", text: "Injected draft" }, {
    kind: "text",
    text: "external transform",
  }]);
  await expect(page.locator("[data-external-dock]")).toHaveCount(0);
  await page.locator("[data-capability]").click();
  await page.locator("[data-external-dock]").click();
  await expect(page.locator("[data-external-dock]")).toHaveText(
    "Injected dock 1",
  );
  await page.locator("[data-external-takeover]").click();
  await expect(page.locator("#opened")).toHaveText("typed external reply");
  await page.locator("[data-open-dialog]").click();
  await expect(page.locator("[data-external-dialog]")).toContainText(
    "Feature-owned dialog",
  );
  await page.locator("[data-close-dialog]").click();
  await expect(page.locator("[data-external-dialog]")).toHaveCount(0);
  await page.locator(".otk-display-menu > button").click();
  await expect(
    page.locator(".otk-display-menu label").filter({
      hasText: "Consumer compact layout",
    }),
  ).toBeAttached();
  await page.locator('input[name="consumer.compact"]').click();
  await expect(page.locator("[data-consumer-preference]")).toHaveText("true");
  await expect(page.locator('input[name="consumer.compact"]')).toBeChecked();
});
