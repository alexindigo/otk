// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-messages-disclosures" });
test("messages.disclosure-settings-save-reload-and-explicit-choice", {
  tag: ["@messages", "@menus", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await openSession(state, page, "tstv1-otk");
  const fold = page.locator(".otk-work-fold");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await state.product("prefs.set", { key: "expandWork", value: true });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await state.product("prefs.set", { key: "expandWork", value: false });
  await state.product("prefs.set", { key: "expandWork", value: true });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  const tool = page.locator(".otk-tool-toggle");
  await expect(tool).toHaveAttribute("aria-expanded", "false");
  await state.product("prefs.set", {
    key: "collapseFileChanges",
    value: false,
  });
  await expect(tool).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".otk-code")).toContainText("foldedSecret");
  await tool.click();
  await state.product("prefs.set", { key: "collapseFileChanges", value: true });
  await state.product("prefs.set", {
    key: "collapseFileChanges",
    value: false,
  });
  await expect(tool).toHaveAttribute("aria-expanded", "false");
  await page.locator(".otk-settings-entry").click();
  const settings = page.getByRole("region", {
    name: "Transcript settings",
    exact: true,
  });
  await expect(settings).toContainText(
    "Your choices on individual rows stay unchanged.",
  );
  for (
    const key of [
      "expandWork",
      "expandToolOutput",
      "expandSystem",
      "expandDelegation",
      "expandOutgoing",
      "expandRecords",
      "expandSource",
      "expandCompaction",
    ] as const
  ) {
    const input = settings.locator(`input[name=${key}]`);
    const baseline = key === "expandWork";
    if (baseline) await expect(input).toBeChecked();
    else await expect(input).not.toBeChecked();
    await input.click();
    await expect.poll(async () => (await state.product("prefs.get", {}))[key])
      .toBe(!baseline);
  }
  await expect(settings.locator("input[name=expandCompaction]"))
    .toHaveAccessibleName("Always keep session compaction expanded");
  await page.reload();
  await page.locator(".otk-settings-entry").click();
  for (
    const key of [
      "expandSystem",
      "expandDelegation",
      "expandOutgoing",
      "expandRecords",
      "expandSource",
      "expandCompaction",
    ]
  ) {
    await expect(settings.locator(`input[name=${key}]`)).toBeChecked();
  }
  await expect(settings.locator("input[name=expandWork]")).not.toBeChecked();
  await expect(settings.locator("input[name=expandToolOutput]")).toBeChecked();
});

for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`messages.disclosure-settings-theme-${theme}`, {
    tag: ["@messages", "@menus", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await state.product("prefs.set", { key: "theme", value: theme });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(state.url);
    await page.locator(".otk-settings-entry").click();
    const settings = page.getByRole("region", {
      name: "Transcript settings",
      exact: true,
    });
    await expect(settings).toBeVisible();
    await expect(settings.locator("select")).toHaveCount(0);
    await expect(settings.getByRole("checkbox")).toHaveCount(12);
    await expect(
      settings.getByRole("region", { name: "Tool visibility", exact: true })
        .getByRole("checkbox"),
    ).toHaveCount(2);
    for (
      const key of [
        "thinking",
        "collapseFileChanges",
        "expandWork",
        "expandToolOutput",
        "expandSystem",
        "expandDelegation",
        "expandOutgoing",
        "expandRecords",
        "expandSource",
        "expandCompaction",
      ]
    ) {
      await expect(settings.locator(`input[name=${key}]`)).not.toBeChecked();
    }
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await page.evaluate(() => document.fonts.ready);
    const { mkdir } = await import("node:fs/promises");
    const out = "/home/tester/otk/.test-state/artifacts/ux1-after";
    await mkdir(out, { recursive: true });
    // A top-of-scroll capture matches the unchanged baseline's recipe. The
    // reader-focused captures below deliberately reveal the new controls.
    await page.screenshot({ path: `${out}/${theme}-top.png`, fullPage: true });
    const compaction = settings.locator("input[name=expandCompaction]");
    await compaction.focus();
    await expect(compaction).not.toBeChecked();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `${out}/${theme}-defaults.png`,
      fullPage: true,
    });
    await compaction.click();
    await expect(compaction).toBeChecked();
    await settings.locator("input[name=expandWork]").hover();
    await page.screenshot({ path: `${out}/${theme}-on.png`, fullPage: true });
    await page.setViewportSize({ width: 600, height: 800 });
    await settings.scrollIntoViewIfNeeded();
    await expect.poll(() =>
      settings.locator(".otk-control-label").evaluateAll((labels) =>
        labels.every((label) => getComputedStyle(label).whiteSpace === "nowrap")
      )
    ).toBe(true);
  });
}

test(
  "messages.legacy-preferences-keep-values-with-positive-disclosure-controls",
  {
    tag: ["@messages", "@menus", "@contracts"],
  },
  async ({ isolatedState: state, page }) => {
    for (const expanded of [false, true]) {
      await state.product("prefs.set", {
        key: "thinking",
        value: expanded ? "show" : "hide",
      });
      await state.product("prefs.set", {
        key: "collapseFileChanges",
        value: !expanded,
      });
      await state.product("prefs.set", { key: "toolDetails", value: expanded });
      await state.product("prefs.set", {
        key: "genericToolOutput",
        value: expanded,
      });
      await page.goto(state.url);
      await page.reload();
      await page.locator(".otk-settings-entry").click();
      const settings = page.getByRole("region", {
        name: "Transcript settings",
        exact: true,
      });
      const thinking = settings.getByRole("checkbox", {
        name: "Expand thinking by default",
        exact: true,
      });
      const files = settings.getByRole("checkbox", {
        name: "Expand file changes by default",
        exact: true,
      });
      for (
        const input of [
          thinking,
          files,
          settings.getByRole("checkbox", {
            name: "Show successful tool rows",
            exact: true,
          }),
          settings.getByRole("checkbox", {
            name: "Show results for unrecognized tools",
            exact: true,
          }),
        ]
      ) {
        if (expanded) await expect(input).toBeChecked();
        else await expect(input).not.toBeChecked();
      }
      await expect(
        settings.getByRole("checkbox", {
          name: "Expand tool output by default",
          exact: true,
        }),
      ).not.toBeChecked();
      await thinking.click();
      await files.click();
      await expect.poll(async () => {
        const prefs = await state.product("prefs.get", {});
        return [
          prefs.thinking,
          prefs.collapseFileChanges,
          prefs.toolDetails,
          prefs.genericToolOutput,
        ];
      }).toEqual([expanded ? "hide" : "show", expanded, expanded, expanded]);
      await page.reload();
      await page.locator(".otk-settings-entry").click();
      for (const input of [thinking, files]) {
        if (expanded) await expect(input).not.toBeChecked();
        else await expect(input).toBeChecked();
      }
    }
  },
);

test.describe("required failure rows", () => {
  test.use({ profile: "contract-messages-facts" });
  test(
    "messages.failed-result-visible-with-closed-defaults-and-tool-details-off",
    {
      tag: ["@messages", "@contracts"],
    },
    async ({ isolatedState: state, page }) => {
      await state.product("prefs.set", { key: "toolDetails", value: false });
      await state.product("prefs.set", {
        key: "genericToolOutput",
        value: false,
      });
      await page.goto(`${state.url}/#/local/tstv1-core`);
      for (const reload of [false, true]) {
        if (reload) await page.reload();
        await expect(page.locator(".otk-work-fold")).toHaveAttribute(
          "aria-expanded",
          "true",
        );
        const row = page.locator("[data-tool=external]");
        await expect(row).toHaveAttribute("data-tool-status", "completed");
        await expect(row).toHaveClass(/is-error/);
        await expect(row.locator(".otk-tool-toggle")).toHaveAttribute(
          "aria-expanded",
          "false",
        );
        await expect(row.locator(".otk-tool-toggle")).toContainText(
          "Nested call failed: usage limit reached",
        );
        await expect(row.locator(".otk-tool-body")).toHaveCount(0);
      }
    },
  );
});
