// SPDX-License-Identifier: LGPL-3.0-only
import { randomUUID } from "node:crypto";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { heapPort } from "../../fixtures/heap.ts";
import { measureSessionHeap } from "../../../support/heap.ts";
test.use({ profile: "contract-visual-native-events" });
test.beforeEach(async ({ isolatedState: state, page }) => {
  await page.route(
    "**/source",
    (route) =>
      route.fulfill({
        body: "OTK_NATIVE_EVENT_" + "native-source ".repeat(8192),
      }),
  );
  await page.goto(state.url);
  await expect.poll(() =>
    page.locator("#event-editor").inputValue().then((v) => v.length)
  ).toBeGreaterThan(100000);
  await page.locator("#event-editor").click();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#event-count")).toHaveText("1");
  await expect(page.locator("#event-target")).toHaveText("event-editor");
});
test("visual.native-current-target-without-retaining-getter", {
  tag: ["@visual", "@isolated"],
}, async ({ page }) => {
  await expect(page.locator("#event-getter")).toHaveText("false");
});
test("visual.retired-context-releases-callback-with-retained-element", {
  tag: ["@visual", "@isolated"],
}, async ({ page }) => {
  expect(await page.evaluate("contextProbe()")).toBe(1);
  await page.locator("#retire-context").click();
  await expect(page.locator("#context-target")).toHaveCount(0);
  expect(await page.evaluate("contextProbe()")).toBe(0);
});
test("visual.retired-input-source-measured-after-native-key", {
  tag: ["@visual", "@isolated"],
}, async ({ page, context }, info) => {
  // A fresh source marker is loaded before the one real key event under measurement.
  const marker = "OTK_NATIVE_EVENT_" + randomUUID() + "_";
  await page.unroute("**/source");
  await page.route(
    "**/source",
    (route) => route.fulfill({ body: marker + "native-source ".repeat(8192) }),
  );
  await page.reload();
  await expect.poll(() =>
    page.locator("#event-editor").inputValue().then((v) => v.length)
  ).toBeGreaterThan(100000);
  await page.locator("#event-editor").click();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#event-count")).toHaveText("1");
  await page.locator("#retire-editor").click();
  await expect(page.locator("#event-editor")).toHaveCount(0);
  const port = await heapPort(context, page);
  try {
    const measurement = await measureSessionHeap(
      port,
      "native-event-input",
      marker,
    );
    await info.attach("retired-input-heap", {
      body: JSON.stringify(measurement),
      contentType: "application/json",
    });
  } finally {
    await port.close();
  }
});
test("visual.live-native-attributes-options-tuple-and-handler-retirement", {
  tag: ["@visual", "@isolated"],
}, async ({ page }) => {
  await page.locator("#forwarded-button").click();
  await expect(page.locator("#clicks")).toHaveText("1");
  await page.locator("#forwarded-button").click();
  await expect(page.locator("#clicks")).toHaveText("1");
  await page.locator("#replace-handler").click();
  await expect(page.locator("#tuple-button")).toHaveAttribute(
    "aria-label",
    "Replacement attributes",
  );
  await page.locator("#tuple-button").click();
  await expect(page.locator("#clicks")).toHaveText("3");
  await expect(page.locator("#receiver")).toHaveText(
    "tuple-button:tuple-button",
  );
  await page.locator("#tuple-button").click();
  await expect(page.locator("#clicks")).toHaveText("5");
  await page.locator("#remove-handler").click();
  await expect(page.locator("#tuple-button")).toHaveAttribute(
    "aria-label",
    "No handler",
  );
  await page.locator("#tuple-button").click();
  await expect(page.locator("#clicks")).toHaveText("5");
});
