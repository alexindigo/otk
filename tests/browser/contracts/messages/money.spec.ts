// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-messages-money" });
test("messages.exact-money-accessibility-all-consumers", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page, context }) => {
  await state.product("layout.patch", { rightCollapsed: false });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${state.url}/#/local/tstv1-core`);
  const cdp = await context.newCDPSession(page);
  let index = 0;
  for (
    const [value, label, exact] of [
      [0, "$0.00", "$0"],
      [.00000005, "<$0.01", "$0.00000005"],
      [.0096, "<$0.01", "$0.0096"],
      [.01, "$0.01", "$0.01"],
      [1.2, "$1.20", "$1.2"],
      [1234.567, "$1,234.57", "$1,234.567"],
    ] as const
  ) {
    if (index++) {
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "release",
      });
    }
    await page.reload();
    await expect(page.locator(".otk-context-meter")).toHaveAttribute(
      "data-cost",
      String(value),
    );
    await expect(page.locator(".otk-context-meter .otk-usage-cost")).toHaveText(
      label,
    );
    await expect(page.locator(".otk-session-cost")).toHaveText(label);
    const trigger = page.locator(".otk-turn-usage > button");
    const triggerName =
      `Turn usage: 1 model call · 100 tokens · ${label}; exact cost ${exact}`;
    await expect(trigger).toHaveText(`1 model call · 100 tokens · ${label}`);
    await expect(trigger).toHaveAttribute("aria-label", triggerName);
    await expect(page.locator(".otk-session-row")).toHaveAttribute(
      "aria-description",
      `Exact session cost: ${exact}`,
    );
    await trigger.evaluate((element) =>
      element.scrollIntoView({ block: "center" })
    );
    await trigger.hover();
    await expect(page.locator(".otk-turn-usage :popover-open")).toBeVisible();
    await expect(page.locator(".otk-usage-breakdown tbody tr")).toHaveCount(1);
    await expect(page.locator("tfoot .otk-usage-category-cost").first())
      .toBeAttached();
    for (
      const selector of [
        "[data-usage-summary=cost] .otk-usage-cost",
        "tbody .otk-usage-cost",
        "tfoot tr > td:nth-last-child(2) .otk-usage-cost",
      ]
    ) await expect(page.locator(selector)).toHaveText(label);
    expect(
      await page.locator("tfoot .otk-usage-category-cost").allTextContents(),
    ).toEqual(["<$0.01", "$0.00", "$0.00", "$0.00", "$0.00"]);
    const categoryExact = await page.locator(
      "tfoot .otk-usage-category-cost .otk-usage-cost",
    ).evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-description")!)
    );
    expect(Math.abs(Number(categoryExact[0].split("$")[1]) - .0002))
      .toBeLessThanOrEqual(1e-12);
    await expect(
      page.locator(".otk-usage-cost[title],.otk-turn-usage > button[title]"),
    ).toHaveCount(0);
    const tree = await cdp.send("Accessibility.getFullAXTree");
    expect(
      tree.nodes.filter((node) =>
        node.role?.value === "group" && node.name?.value === label &&
        node.description?.value === `Exact cost: ${exact}`
      ),
    ).toHaveLength(value === 0 ? 8 : 4);
    expect(
      tree.nodes.some((node) =>
        node.role?.value === "button" &&
        node.description?.value === `Exact session cost: ${exact}`
      ),
    ).toBe(true);
    expect(
      tree.nodes.some((node) =>
        node.role?.value === "button" && node.name?.value === triggerName
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await page.mouse.move(1, 1);
  }
  await page.locator(".otk-display-menu > button").click();
  await page.locator("input[name=showCost]").click();
  await expect(page.locator(".otk-usage-cost,.otk-session-cost")).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator(".otk-turn-usage > button")).toHaveText(
    "1 model call · 100 tokens",
  );
  await expect(
    page.locator(
      '.otk-usage-cost,.otk-session-cost,[aria-description*="$"],[aria-label*="$"]',
    ),
  ).toHaveCount(0);
  await expect(page.locator(".otk-context-meter")).not.toHaveAttribute(
    "data-cost",
  );
  await cdp.detach();
});
