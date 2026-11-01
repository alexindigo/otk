// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "@playwright/test";

test("managed Chromium accepts trusted input and renders geometry", {
  tag: "@harness",
}, async ({
  page,
  browser,
}, testInfo) => {
  await page.goto(new URL("./scene.html", import.meta.url).href);
  const counter = page.getByRole("status", { name: "Counter" });
  await expect(counter).toHaveText("Count: 0");
  await page.getByRole("button", { name: "Increment counter" }).click();
  await expect(counter).toHaveText("Count: 1; trusted: true");

  const text = "Hello, Καλημέρα — 日本語 — café — 👋🌍";
  const input = page.getByRole("textbox", { name: "Unicode text" });
  await input.pressSequentially(text);
  await expect(input).toHaveValue(text);

  const box = await page.getByRole("region", { name: "Tooling scene" })
    .boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) throw new Error("Missing scene or viewport geometry");
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2))
    .toBeLessThanOrEqual(0.5);
  expect(Math.abs(box.y + box.height / 2 - viewport.height / 2))
    .toBeLessThanOrEqual(0.5);

  const observation = {
    browser: browser.version(),
    counter: await counter.innerText(),
    text: await input.inputValue(),
    box,
    viewport,
  };
  await testInfo.attach("observations", {
    body: JSON.stringify(observation, null, 2),
    contentType: "application/json",
  });
  const screenshot = testInfo.outputPath("tooling-full.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("full screenshot", {
    path: screenshot,
    contentType: "image/png",
  });
  console.info(JSON.stringify({ ...observation, screenshot }));
});
