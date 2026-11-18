// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../fixtures/evidence.ts";
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { prompt } from "../pages/composer.ts";

// A real HTTP origin, not localhost and not an emulated missing API. Resolution
// stays within the owned test guest; no listener is exposed to the Internet.
test.use({
  launchOptions: {
    args: [
      "--host-resolver-rules=MAP insecure.otk.test 127.0.0.1",
      "--no-proxy-server",
    ],
  },
});

test("browser.insecure-origin-renders-opens-sends-and-copies", {
  tag: ["@messages", "@composer", "@insecure"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Plain HTTP session",
  });
  const origin = new URL(state.url);
  origin.hostname = "insecure.otk.test";
  await page.goto(`${origin.origin}/#/local/${session.id}`);
  expect(await page.evaluate(() => globalThis.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  await expect(prompt(page)).toBeVisible();
  await expect(page.getByRole("region", { name: "Transcript", exact: true }))
    .toHaveAttribute("aria-busy", "false");
  await state.queue(["Plain HTTP reply"]);
  await prompt(page).fill("Plain HTTP prompt");
  await page.locator(".otk-prompt button[type=submit]").click();
  await expect(page.locator("[data-role=assistant]")).toContainText(
    "Plain HTTP reply",
  );
  await expect(page.getByRole("button", { name: "Copy reply", exact: true }))
    .toBeVisible();
  await expect(prompt(page)).toHaveValue("");
  // Observe the native copy event without replacing execCommand or its result.
  await page.evaluate(() => {
    document.addEventListener("copy", () => {
      document.documentElement.dataset.copyEvent = "observed";
    });
  });
  await page.getByRole("button", { name: "Copy reply", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-copy-event",
    "observed",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  // A plain native field observes actual clipboard bytes, not a mocked write.
  await page.evaluate(() => {
    const probe = document.createElement("textarea");
    probe.id = "clipboard-probe";
    document.body.append(probe);
  });
  await page.locator("#clipboard-probe").focus();
  await page.keyboard.press("Control+v");
  await expect(page.locator("#clipboard-probe")).toHaveValue(
    "Plain HTTP reply",
  );
  await page.locator("#clipboard-probe").evaluate((element) =>
    element.remove()
  );
  // A refusal must reach the existing FP1 presentation, never silently succeed.
  await page.evaluate(() => {
    document.execCommand = () => false;
  });
  await page.getByRole("button", { name: "Copy reply", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Copy");
  await expect(page.getByRole("alert")).toContainText("clipboard");
  await expect(page.getByRole("alert")).toContainText("Ctrl+C");
});
