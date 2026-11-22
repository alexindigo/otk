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

test("sessions.tab-groups-disjoint-phantoms-ancestor-links-more-and-reload", {
  tag: ["@sessions", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  for (const id of [root, a, b]) await activity(state, id, "hold");
  await openSession(state, page, root);
  const trail = async (members: string[], links: string[]) => {
    await expect(page.locator('[data-crumb-kind="member"][data-crumb]'))
      .toHaveCount(members.length);
    await expect(page.locator('[data-crumb-kind="ancestor"][data-crumb]'))
      .toHaveCount(links.length);
    for (const id of members) {
      await expect(
        page.locator(`[data-crumb="${id}"][data-crumb-kind="member"]`),
      ).toBeAttached();
    }
    for (const id of links) {
      await expect(
        page.locator(`a[data-crumb="${id}"][data-crumb-kind="ancestor"]`),
      ).toBeAttached();
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    if (pass) await page.reload();
    for (const id of [root, a, b]) {
      await visibleOnScreen(page.locator(`[data-tab="${id}"]`));
      await page.locator(`[data-tab="${id}"]`).click();
      await expect(page.locator(`[data-tab="${id}"]`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await trail([id], id === root ? [] : [root]);
    }
    await page.locator(`[data-session="${quiet}"]`).click();
    await expect(page.locator(`[data-tab="${root}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await trail([root, quiet], []);
    await page.locator(`[data-tab="${root}"]`).click();
    await trail([root], []);
  }
  await page.locator(`[data-tab="${a}"]`).click();
  await page.setViewportSize({ width: 900, height: 800 });
  const more = page.getByRole("button", {
    name: "More task sessions",
    exact: true,
  });
  await expect(more).toBeVisible();
  await more.click();
  const choices = page.locator(".otk-folded-crumbs [data-overflow-target]");
  await expect(choices).toHaveCount(1);
  await expect(choices).toHaveAttribute("data-overflow-target", root);
  await expect(choices).toHaveAttribute("data-crumb-kind", "ancestor");
  await choices.click();
  await expect(page.locator(`[data-tab="${root}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await trail([root], []);
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
    const second = await state.product("tasks.create", {
      directory: state.directory,
      name: "Explore group A",
      sessions: [a],
    });
    await openSession(state, page, root);
    for (let pass = 0; pass < 2; pass++) {
      if (pass) await page.reload();
      await page.locator(`[data-tab="${first.id}"]`).click();
      await expect(page.locator(`[data-crumb="${a}"]`)).toHaveCount(0);
      await expect(
        page.locator(`[data-crumb="${b}"][data-crumb-kind="member"]`),
      ).toBeVisible();
      await page.locator(`[data-tab="${second.id}"]`).click();
      await expect(
        page.locator(`[data-crumb="${a}"][data-crumb-kind="member"]`),
      ).toBeVisible();
      const ancestor = page.locator(
        `a[data-crumb="${root}"][data-crumb-kind="ancestor"]`,
      );
      await expect(ancestor).toBeAttached();
      if (!await ancestor.isVisible()) {
        await page.getByRole("button", {
          name: "More task sessions",
          exact: true,
        }).click();
        const link = page.locator(
          `.otk-folded-crumbs [data-overflow-target="${root}"][data-crumb-kind="ancestor"]`,
        );
        await expect(link).toBeVisible();
        await expect(page.locator(".otk-folded-crumbs [data-overflow-target]"))
          .toHaveCount(1);
        await page.keyboard.press("Escape");
      }
      await expect.poll(() =>
        page.locator(`[data-crumb="${a}"]`).evaluate((element) => {
          const box = element.getBoundingClientRect();
          const lane = element.closest(".otk-overflow-items")!
            .getBoundingClientRect();
          return box.width > 0 && box.left >= lane.left - 1 &&
            box.right <= lane.right + 1;
        })
      ).toBe(true);
      await expect(page.locator(`[data-crumb="${b}"]`)).toHaveCount(0);
    }
    await state.product("tasks.close", { id: second.id });
    // With no explicit child task, A inherits the saved parent task, not a
    // competing phantom. This is case 1, not ungrouped case 2.
    await expect(page.locator(`[data-tab="${first.id}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator(`[data-crumb="${a}"][data-crumb-kind="member"]`))
      .toBeVisible();
    await activity(state, b, "release");
    const finishes = await state.product("sessions.finishes", {});
    await state.product("sessions.seen", {
      sessionID: b,
      terminal: finishes[b],
    });
    await expect(page.locator(`[data-crumb="${b}"]`)).toHaveCount(0);
  },
);

test("sessions.tab-groups-dark-light-selected-child-trail", {
  tag: ["@sessions", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  for (const id of [root, a, b]) await activity(state, id, "hold");
  await openSession(state, page, root);
  await page.locator(`[data-tab="${a}"]`).click();
  await expect(page.getByRole("region", { name: "Transcript", exact: true }))
    .toHaveAttribute("aria-busy", "false");
  for (const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    for (const id of [root, a, b]) {
      await visibleOnScreen(page.locator(`[data-tab="${id}"]`));
    }
    await expect(page.locator(`[data-tab="${a}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.locator(`[data-crumb="${root}"][data-crumb-kind="ancestor"]`),
    ).toBeVisible();
    await expect(page.locator(`[data-crumb="${a}"][data-crumb-kind="member"]`))
      .toBeVisible();
    await expect(page.locator(`[data-crumb="${b}"]`)).toHaveCount(0);
    if (process.env.OTK_FIX42_SCREENSHOTS) {
      await page.screenshot({
        path: `${process.env.OTK_FIX42_SCREENSHOTS}/${name}.png`,
        fullPage: true,
      });
    }
  }
});
