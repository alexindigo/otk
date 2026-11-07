// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { expect } from "../../fixtures/evidence.ts";
test.use({ profile: "contract-load-priority" });
test("transport.current-page-renders-before-optional-backfill", {
  tag: ["@load", "@transport", "@sessions"],
}, async ({ isolatedState: state, page }) => {
  await page.addInitScript(() => {
    const Native = WebSocket;
    const observations: { selected?: string; rendered: boolean }[] = [];
    Object.assign(globalThis, { pageAcceptances: observations });
    globalThis.WebSocket = class extends Native {
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (frame.t === "view.settled") {
            observations.push({
              selected: frame.sessionID,
              rendered:
                document.querySelector(".otk-messages")?.textContent?.includes(
                  "Core transcript",
                ) ?? false,
            });
          }
        }
        super.send(data);
      }
    };
  });
  await page.goto(`${state.url}/#/local/tstv1-core`);
  await expect.poll(async () =>
    (await state.observe<{ reads: number }>()).reads
  ).toBe(1);
  expect((await state.observe<{ jobs: string[] }>()).jobs).toEqual([]);
  await expect(page.locator(".otk-messages")).not.toContainText(
    "Core transcript",
  );
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "release",
  });
  await expect(page.locator(".otk-messages")).toContainText("Core transcript");
  await expect.poll(async () =>
    (await state.observe<{ jobs: string[] }>()).jobs
  ).toEqual(["background"]);
  expect(await page.evaluate("pageAcceptances")).toEqual([{
    selected: "tstv1-core",
    rendered: true,
  }]);
});
