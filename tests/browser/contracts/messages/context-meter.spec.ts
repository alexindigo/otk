// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-messages-context" });
test("messages.composer-meter-share-held-catalog", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(`${state.url}/#/local/tstv1-core`);
  await expect(page.locator(".otk-model-picker > button")).toBeAttached();
  await expect(page.locator(".otk-context-meter")).toHaveAttribute(
    "data-tokens",
    "2500",
  );
  await expect.poll(async () =>
    (await state.observe<{ modelCalls: string[] }>()).modelCalls.length
  ).toBeGreaterThan(0);
  expect((await state.observe<{ modelCalls: string[] }>()).modelCalls).toEqual([
    "tstv1-core",
  ]);
  await expect(page.locator(".otk-context-bar")).toHaveCount(0);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "release",
  });
  await expect(page.locator(".otk-model-picker .otk-composer-model-name"))
    .toHaveText("Beam Free");
  await expect(page.locator(".otk-context-bar")).toHaveAttribute(
    "aria-valuenow",
    "25",
  );
  expect((await state.observe<{ modelCalls: string[] }>()).modelCalls).toEqual([
    "tstv1-core",
  ]);
  await page.reload();
  await expect(page.locator(".otk-model-picker .otk-composer-model-name"))
    .toHaveText("Beam Free");
  await expect(page.locator(".otk-context-bar")).toHaveAttribute(
    "aria-valuenow",
    "25",
  );
  expect((await state.observe<{ modelCalls: string[] }>()).modelCalls).toEqual([
    "tstv1-core",
    "tstv1-core",
  ]);
});
