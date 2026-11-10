// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-menus-session-actions" });

for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`session-actions additive menus and file mode ${theme}`, {
    tag: ["@menus", "@sessions", "@revert", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    await state.product("prefs.set", { key: "theme", value: theme });
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await expect(page.locator(".otk-user-bubble")).toContainText(
      "Keep session actions reversible",
    );
    const chip = page.getByRole("navigation", { name: "Task sessions" })
      .getByRole("button", { name: "Session actions review", exact: true });
    await chip.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Archive", exact: true }))
      .toBeVisible();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).hover();
    await page.screenshot({
      path: info.outputPath(`${theme}-session-menu.png`),
      fullPage: true,
    });
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect.poll(async () =>
      (await state.observe<{ calls: unknown[] }>()).calls
    ).toContainEqual(["archive", "tstv1-core", true]);
    await chip.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Unarchive", exact: true }))
      .toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Archive", exact: true }))
      .toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.locator(".otk-user-bubble").click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Revert to here", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Revert code changes", exact: true }),
    ).toBeVisible();
    const labels = await page.getByRole("menuitem").evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.textContent,
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
        whitespace: getComputedStyle(node.querySelector(".otk-control-label")!)
          .whiteSpace,
        labelHeight:
          node.querySelector(".otk-control-label")!.getBoundingClientRect()
            .height,
        lineHeight: parseFloat(
          getComputedStyle(node.querySelector(".otk-control-label")!)
            .lineHeight,
        ),
      }))
    );
    expect(
      labels.every((label) =>
        label.width > 0 && Math.abs(label.height - 28) <= 1 &&
        label.whitespace === "nowrap" &&
        label.labelHeight <= label.lineHeight + 1
      ),
    ).toBe(
      true,
    );
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitem", { name: "Revert code changes", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`${theme}-message-menu.png`),
      fullPage: true,
    });
    await page.getByRole("menuitem", {
      name: "Revert code changes",
      exact: true,
    }).click();
    await expect.poll(async () =>
      (await state.observe<{ calls: unknown[] }>()).calls
    ).toContainEqual(["code", "tstv1-core", "prompt-v4"]);
    await expect(page.locator(".otk-rolled-back-strip")).toContainText(
      "1 prompt rolled back",
    );
  });
}
