// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openWorkLogs } from "../../pages/transcript.ts";

test.describe("file-change preference", () => {
  test.use({ profile: "contract-messages-collapse" });
  test("messages.file-changes-disclosure-persistence", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await openWorkLogs(page);
    await expect(page.locator(".otk-tool-line")).toHaveCount(4);
    await expect(page.locator(".otk-turn-usage > button")).toBeAttached();
    const check = async (open: boolean) => {
      const rows = page.locator(
        "[data-tool=edit],[data-tool=write],[data-tool=patch]",
      );
      await expect(rows).toHaveCount(3);
      await expect.poll(() =>
        rows.evaluateAll(
          (rows, open) =>
            rows.every((row) =>
              row.querySelector(".otk-tool-toggle")!.getAttribute(
                  "aria-expanded",
                ) === String(open) &&
              !!row.querySelector(".otk-tool-body") === open &&
              ((row.querySelector(".otk-tool-body")?.getBoundingClientRect()
                  .height ?? 0) > 0) === open
            ),
          open,
        )
      ).toBe(true);
      await expect(page.locator("[data-tool=read] .otk-tool-body")).toHaveCount(
        0,
      );
    };
    await check(false);
    expect((await state.product("prefs.get", {})).collapseFileChanges).toBe(
      true,
    );
    for (const tool of ["edit", "patch"]) {
      await expect(page.locator(`[data-tool=${tool}] .otk-tool-target`))
        .toHaveText(`${tool}.ts`);
      await expect(page.locator(`[data-tool=${tool}] .otk-tool-add`))
        .toHaveText("+1");
      await expect(page.locator(`[data-tool=${tool}] .otk-tool-del`))
        .toHaveText("−1");
    }
    for (const tool of ["edit", "write", "patch"]) {
      await page.locator(`[data-tool=${tool}] .otk-tool-toggle`).click();
    }
    await check(true);
    await expect(page.locator("[data-tool=edit] .otk-diff")).toContainText(
      "const after = true;",
    );
    await expect(page.locator("[data-tool=patch] .otk-diff")).toContainText(
      "const after = true;",
    );
    await expect(page.locator("[data-tool=write] .otk-code")).toContainText(
      "const written = true;",
    );
    await page.reload();
    await openWorkLogs(page);
    await check(false);
    await page.locator(".otk-display-menu > button").click();
    await expect(page.locator("input[name=collapseFileChanges]")).not
      .toBeChecked();
    await page.locator("input[name=collapseFileChanges]").click();
    await check(true);
    await page.keyboard.press("Escape");
    expect((await state.product("prefs.get", {})).collapseFileChanges).toBe(
      false,
    );
    await page.reload();
    await openWorkLogs(page);
    await check(true);
    await page.locator("[data-tool=edit] .otk-tool-toggle").click();
    await state.product("prefs.set", {
      key: "collapseFileChanges",
      value: true,
    });
    await check(false);
    await state.product("prefs.set", {
      key: "collapseFileChanges",
      value: false,
    });
    await expect(page.locator("[data-tool=edit] .otk-tool-body")).toHaveCount(
      0,
    );
    await expect(page.locator("[data-tool=write] .otk-tool-body"))
      .toBeVisible();
    await expect(page.locator("[data-tool=patch] .otk-tool-body"))
      .toBeVisible();
    await page.reload();
    await openWorkLogs(page);
    await check(true);
    await state.product("prefs.set", {
      key: "collapseFileChanges",
      value: true,
    });
    await check(false);
    await page.reload();
    await openWorkLogs(page);
    await check(false);
  });
});

for (const picker of [false, true]) {
  test.describe(`literal labels ${picker ? "picker" : "plain"}`, () => {
    test.use({
      profile: picker
        ? "contract-messages-labels-picker"
        : "contract-messages-labels",
    });
    test(`messages.literal-labels-${picker ? "picker" : "plain"}`, {
      tag: ["@messages", "@contracts"],
    }, async ({ isolatedState: state, page }) => {
      await page.goto(`${state.url}/#/local/tstv1-core`);
      await expect(page.locator(".otk-turn-usage > button")).toHaveText(
        "1 model call · 1 token · $0.00",
      );
      await expect(page.locator(".otk-turn-usage > button")).toHaveAttribute(
        "aria-label",
        "Turn usage: 1 model call · 1 token · $0.00; exact cost $0",
      );
      await expect(page.locator(".otk-context-meter > span").first())
        .toHaveText("1 token");
      await expect(
        page.locator(
          picker
            ? ".otk-agent-picker .otk-composer-agent"
            : ".otk-prompt-context > span",
        ).first(),
      ).toHaveText("Default agent");
      await expect(page.locator(".otk-composer-model-name")).toHaveText(
        "Default model",
      );
      if (picker) {
        await expect(page.locator(".otk-agent-picker > button"))
          .toHaveAttribute("aria-label", "Agent: Default agent");
      } else {
        await page.locator("textarea[name=prompt]").evaluate((element) => {
          const data = new DataTransfer();
          data.setData("text/plain", "long pasted line ".repeat(20));
          element.dispatchEvent(
            new ClipboardEvent("paste", { bubbles: true, clipboardData: data }),
          );
        });
        await expect(page.locator(".otk-prompt-chip")).toContainText(
          "[Pasted ~1 line]",
        );
        await state.controller.call("scenario", {
          lease: state.lease.lease,
          action: "release",
        });
        await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
          "1 prompt rolled back",
        );
      }
    });
  });
}
