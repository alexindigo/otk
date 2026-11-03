// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-messages-usage500" });
test("messages.usage-500-call-lazy-paint", {
  tag: ["@messages", "@scale", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  await page.goto(`${state.url}/#/local/tstv1-core`);
  await expect(page.locator(".otk-turn-usage > button")).toHaveText(
    /^500 model calls/,
  );
  await expect(page.locator(".otk-composer-model-name")).toBeAttached();
  const samples: number[] = [];
  for (let index = 0; index < 5; index++) {
    await page.locator("textarea[name=prompt]").click();
    await expect(page.locator(".otk-usage-breakdown tbody tr")).toHaveCount(0);
    samples.push(
      await page.evaluate(async () => {
        const start = performance.now();
        (document.querySelector(".otk-turn-usage > button") as HTMLElement)
          .focus();
        while (
          document.querySelectorAll(".otk-usage-breakdown tbody tr").length !==
            500
        ) {
          if (performance.now() - start > 2000) {
            throw new Error(
              "500 rows did not mount: " + document.activeElement?.outerHTML,
            );
          }
          await new Promise(requestAnimationFrame);
        }
        await new Promise(requestAnimationFrame);
        return performance.now() - start;
      }),
    );
    await page.keyboard.press("Escape");
    await expect(page.locator(".otk-turn-usage :popover-open")).toHaveCount(0);
    await expect(page.locator(".otk-usage-breakdown tbody tr")).toHaveCount(0);
    await page.keyboard.press("Tab");
  }
  console.info("U14 500-call open-to-painted-row ms", JSON.stringify(samples));
  await info.attach("usage-500-call-samples", {
    body: JSON.stringify(samples),
    contentType: "application/json",
  });
});
