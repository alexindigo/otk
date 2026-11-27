// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { activity, visibleOnScreen } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-tab-groups" });
const root = "tstv1-otk",
  a = "tstv1-group-a",
  b = "tstv1-group-b",
  quiet = "tstv1-group-quiet";

// 2.67 supersedes #71's independent helper phantom/explicit-helper boundaries.
// Keep the partition, reload, overflow, membership and theme coverage.
test("sessions.tab-groups-disjoint-phantoms-ancestor-links-more-and-reload", {
  tag: ["@sessions", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  for (const id of [root, a, b]) await activity(state, id, "hold");
  await openSession(state, page, root);
  for (let pass = 0; pass < 2; pass++) {
    if (pass) await page.reload();
    await expect(page.locator(`[data-tab="${a}"]`)).toHaveCount(0);
    await page.locator(`[data-tab="${b}"]`).click();
    await expect(page.locator(`[data-crumb="${b}"]`)).toBeVisible();
    await expect(page.locator(`[data-crumb="${a}"]`)).toHaveCount(0);
    await page.locator(`[data-tab="${root}"]`).click();
    // D67: the ancestry stays separate from the composer's D66 inventory.
    await expect(page.locator(`[data-crumb="${a}"]`)).toHaveCount(0);
    await page.getByRole("button", { name: /^Subagents:/ }).click();
    await expect(page.locator(`[data-subagent="${a}"]`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(`[data-crumb="${b}"]`)).toHaveCount(0);
    await page.locator(`[data-session="${quiet}"]`).click();
    await expect(page.locator(`[data-tab="${root}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator(`[data-crumb="${quiet}"]`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.locator(`[data-tab="${root}"]`).click();
    await expect(page.locator(`[data-crumb="${quiet}"]`)).toHaveCount(0);
  }
  await page.locator(`[data-session="${a}"]`).click();
  await page.setViewportSize({ width: 900, height: 800 });
  // D74: the ancestor links are behind the sheet at this width.
  await page.getByRole("button", { name: "Back to conversation" }).click();
  await expect(page.locator(`[data-crumb="${a}"]`)).toBeVisible();
  await expect.poll(() =>
    page.locator(`[data-crumb="${a}"]`).evaluate((element) => {
      const box = element.getBoundingClientRect();
      const lane = element.closest(".otk-overflow-items")!
        .getBoundingClientRect();
      return box.width > 0 && box.left >= lane.left - 1 &&
        box.right <= lane.right + 1;
    })
  ).toBe(true);
  const rootCrumb = page.locator(`[data-crumb="${root}"]`);
  await rootCrumb.click();
  await expect(page.locator(`[data-crumb="${root}"]`)).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(await state.product("tasks.list", { directory: state.directory }))
    .toEqual([]);
});

test(
  "sessions.tab-groups-saved-child-boundary-promotion-close-and-retirement",
  {
    tag: ["@sessions", "@contracts", "@isolated"],
  },
  async ({ isolatedState: state, page }) => {
    for (const id of [root, a, b]) await activity(state, id, "hold");
    const first = await state.product("tasks.create", {
      directory: state.directory,
      name: "Main task",
      sessions: [root],
    });
    const helperRecord = await state.product("tasks.create", {
      directory: state.directory,
      name: "Legacy helper record",
      sessions: [a],
    });
    const second = await state.product("tasks.create", {
      directory: state.directory,
      name: "Another human task",
      sessions: [b],
    });
    await openSession(state, page, root);
    await page.locator(`[data-session="${a}"]`).click();
    for (let pass = 0; pass < 2; pass++) {
      if (pass) await page.reload();
      await expect(page.locator(`[data-tab="${helperRecord.id}"]`)).toHaveCount(
        0,
      );
      await expect(page.locator(`[data-tab="${first.id}"]`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.locator(`[data-crumb="${a}"]`)).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page.locator(`[data-crumb="${b}"]`)).toHaveCount(0);
      await page.locator(`[data-tab="${second.id}"]`).click();
      await expect(page.locator(`[data-crumb="${a}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-crumb="${b}"]`)).toHaveAttribute(
        "aria-current",
        "page",
      );
      await page.locator(`[data-tab="${first.id}"]`).click();
    }
    await state.product("tasks.close", { id: second.id });
    await expect(page.locator(`[data-tab="${b}"]`)).toBeVisible();
    await activity(state, b, "release");
    await state.product("sessions.seen", {
      sessionID: b,
      terminal: (await state.product("sessions.finishes", {}))[b],
    });
    await expect(page.locator(`[data-tab="${b}"]`)).toHaveCount(0);
    expect(
      (await state.product("tasks.list", { directory: state.directory })).find((
        record,
      ) => record.id === helperRecord.id)?.sessions,
    ).toEqual([a]);
  },
);

test("sessions.tab-groups-dark-light-selected-child-trail", {
  tag: ["@sessions", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  for (const id of [root, a, b]) await activity(state, id, "hold");
  await openSession(state, page, root);
  await page.locator(`[data-session="${a}"]`).click();
  for (
    const [name, theme] of [["dark", "otk-dark"], ["linen", "otk-light"], [
      "stone",
      "otk-light-stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    for (const id of [root, b]) {
      await visibleOnScreen(page.locator(`[data-tab="${id}"]`));
    }
    await expect(page.locator(`[data-tab="${a}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-tab="${root}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator(`[data-crumb="${root}"]`)).toBeVisible();
    await expect(page.locator(`[data-crumb="${a}"]`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator(`[data-crumb="${b}"]`)).toHaveCount(0);
    if (process.env.OTK_FIX42_SCREENSHOTS) {
      await page.screenshot({
        path: `${process.env.OTK_FIX42_SCREENSHOTS}/${name}.png`,
        fullPage: true,
      });
    }
  }
});
