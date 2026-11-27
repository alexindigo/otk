// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { labelDisclosure } from "../disclosure-contract.ts";

test.use({ profile: "contract-visual-styles" });
const tag = { tag: ["@composer", "@contracts"] };

for (const width of [1560, 900]) {
  test(`composer.disclosure.notice-details-${width}`, tag, async ({
    page,
    isolatedState: state,
  }) => {
    await page.setViewportSize({ width, height: 980 });
    await page.goto(`${state.url}/?scene=error-surfaces`);
    const notice = page.locator(".otk-composer-notice");
    const trigger = notice.getByRole("button", {
      name: "Details",
      exact: true,
    });
    const region = await labelDisclosure(trigger);
    expect(
      await trigger.evaluate((el) => {
        const row = el.closest(".otk-composer-notice")!
          .querySelector(".otk-operation-feedback")!;
        const rect = el.getBoundingClientRect();
        return rect.top >= row.getBoundingClientRect().bottom &&
          rect.width < row.getBoundingClientRect().width;
      }),
    ).toBe(true);
    await trigger.press("ArrowRight");
    await expect(region).toContainText("No diagnostic ID supplied");
    const more = notice.getByRole("button", { name: "More actions" });
    if (await more.isVisible()) {
      await more.click();
      await expect(page.getByRole("menu").getByText("Details", { exact: true }))
        .toHaveCount(0);
    }
    await page.reload();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
}

test("composer.disclosure.requested-scope", tag, async ({
  page,
  isolatedState: state,
}) => {
  await page.goto(
    `${state.url}/?scene=request-lifetime&kind=permission&patterns=2`,
  );
  const trigger = page.getByRole("button", { name: /^Requested scope/ });
  const region = await labelDisclosure(trigger);
  await expect(trigger).toContainText("2");
  await trigger.press("ArrowRight");
  await expect(region.getByRole("listitem")).toHaveText(["echo probe", "pwd"]);
  await page.reload();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("composer.disclosure.requested-scope-empty", tag, async ({
  page,
  isolatedState: state,
}) => {
  await page.goto(
    `${state.url}/?scene=request-lifetime&kind=permission&patterns=0`,
  );
  await expect(page.locator(".otk-permission-summary")).toContainText("bash");
  await expect(page.getByRole("button", { name: /^Requested scope/ }))
    .toHaveCount(0);
});
