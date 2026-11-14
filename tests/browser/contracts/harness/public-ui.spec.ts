// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-messages-public-ui" });
test("harness.public-ui-unregistered-extension-fallbacks", {
  tag: ["@harness", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(`${state.url}/?interaction-failures`);
  // NT1 presents unknown parts as native-record rows, not muted paragraphs.
  await expect(
    page.locator('[data-native-record="consumer.unregistered"] .otk-tool-verb'),
  ).toHaveText(
    "Unsupported part: consumer.unregistered",
  );
  // UX1 also folds this standalone consumer's work before its lazy tool body.
  await page.getByRole("button", { name: "Work log", exact: true }).click();
  await page.locator('.otk-tool-toggle[aria-expanded="false"]').click();
  await expect(page.locator(".otk-tool-body")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Output truncated.");
  await expect(page.locator(".otk-tool-body")).toContainText(
    "Common output survives an unregistered extension.",
  );
});

for (const draft of [false, true]) {
  test(
    `harness.public-ui-clipboard-refusal-${draft ? "retained-draft" : "reply"}`,
    {
      tag: ["@harness", "@isolated"],
    },
    async ({ isolatedState: state, page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${state.url}/?interaction-failures`);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: () => Promise.reject(new Error("Clipboard refused")),
          },
        });
      });
      await page.locator("[data-dark]").click();
      if (draft) {
        await page.locator(".otk-prompt textarea").fill(
          "Retain this unsent input",
        );
      }
      await page.locator(".otk-copy-message").click();
      await expect(page.locator(".otk-message [role=alert]")).toHaveText(
        /No publishable failure reason is available/,
      );
      await expect(page.locator("body")).toContainText(
        "Keep this reply available",
      );
      if (draft) {
        await expect(page.locator(".otk-prompt textarea")).toHaveValue(
          "Retain this unsent input",
        );
      }
    },
  );
}

test("harness.public-ui-unknown-failure-owned-feedback", {
  tag: ["@harness", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${state.url}/?error-boundaries`);
  await page.locator("[data-login] input[name=username]").fill("consumer");
  await page.locator("[data-login] input[name=password]").fill("test input");
  for (const kind of ["null", "string"]) {
    await page.locator(`[data-${kind}]`).click();
    for (
      const [control, region] of [
        ["[data-login] button[type=submit]", "data-login"],
        ["[data-preferences] input[name=reducedColors]", "data-preferences"],
        ['[data-command="consumer.failure"]', "data-palette"],
      ]
    ) {
      await page.locator(control).click();
      await expect(page.locator(`[${region}] [role=alert]`)).toHaveText(
        /No publishable failure reason is available/,
      );
    }
    await expect(page.locator("[data-login] input[name=username]")).toHaveValue(
      "consumer",
    );
    await expect(page.locator("[data-preferences] input[name=reducedColors]"))
      .not.toBeChecked();
  }
});

test("harness.public-ui-server-metadata-formatters-and-output-policy", {
  tag: ["@harness", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(`${state.url}/?metadata-policy`);
  await expect(page.locator("[data-path]")).toHaveText("src\\file.ts");
  await expect(page.locator("[data-format]")).toHaveText(
    "1,234,567 1.2s 1d 1h",
  );
  await expect.poll(() =>
    page.locator("pre").textContent().then(
      (text) => text!.split("\n").length,
    )
  ).toBe(15);
  await expect(page.locator(".otk-output-toggle")).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      "--font-ui",
      '"Quoted" & <unsafe>',
    );
  });
  await expect.poll(() =>
    page.locator('link[rel="icon"]').getAttribute("href")
      .then((href) => decodeURIComponent(href!).includes("&amp;"))
  ).toBe(true);
  const svg = await page.evaluate(() => {
    const source = decodeURIComponent(
      document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href.split(
        ",",
      )
        .slice(1).join(","),
    );
    const svg = new DOMParser().parseFromString(source, "image/svg+xml");
    return {
      font: svg.querySelector("text")!.getAttribute("font-family"),
      expected: getComputedStyle(document.documentElement).getPropertyValue(
        "--font-ui",
      ).trim(),
      unsafe: svg.querySelectorAll("unsafe,script,parsererror").length,
    };
  });
  expect(svg.font).toBe(svg.expected);
  expect(svg.unsafe).toBe(0);
});
