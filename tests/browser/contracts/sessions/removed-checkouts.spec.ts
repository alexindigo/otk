// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { activity, visibleOnScreen } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-removed" });
test("sessions.removed-checkouts-retain-repo-policy-and-mandatory-activity", {
  tag: ["@sessions", "@projects", "@attention", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  const { root, entries } = await state.observe<
    { root: string; entries: { id: string; directory: string }[] }
  >();
  const canonical = entries[0].directory,
    one = root + "/worktrees/feature-one",
    two = root + "/worktrees/feature-two";
  const row = (directory: string) =>
    page.locator(`.otk-project-row[data-project=${JSON.stringify(directory)}]`);
  await page.goto(state.url);
  for (const directory of [one, two]) {
    await visibleOnScreen(row(directory));
    await expect(row(directory)).toHaveAttribute(
      "data-project-parent",
      canonical,
    );
    await expect(row(directory)).toHaveAttribute("data-group", "active");
  }
  await row(one).locator(".otk-project-open").click();
  await expect(row(one + "/src")).toHaveCount(0);
  await expect(page.locator("[data-tab=tstv1-worktree-0]")).toBeVisible();
  const summaries = (await state.product("inbox.get", {})).inbox.summaries!;
  expect(summaries[one].availability).toBe("removed");
  expect(summaries[one].scopes).toEqual([one, one + "/src"]);
  expect(summaries[one].sessionCount).toBe(2);
  expect(summaries[two].availability).toBe("removed");
  await state.product("layout.patch", { rightCollapsed: true });
  await page.reload();
  await visibleOnScreen(row(two));
  await expect(row(two)).toHaveAttribute("data-group", "active");
  for (
    const [theme, label] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await page.screenshot({
      path: info.outputPath(`ph1-${label}-removed.png`),
      fullPage: true,
    });
  }
  await state.product("projects.inactive", { directory: two, inactive: true });
  await expect(row(two)).toHaveCount(0);
  await activity(state, "tstv1-worktree-1", "hold");
  await visibleOnScreen(row(two));
  await expect(row(two)).toHaveAttribute("data-group", "active");
  await expect(row(two)).toHaveAttribute("data-rollup", "working");
  await state.product("layout.patch", {
    leftCollapsed: true,
    rightCollapsed: true,
  });
  await page.reload();
  await visibleOnScreen(
    row(two).locator(".otk-status-light[data-state=working]"),
  );
  await activity(state, "tstv1-worktree-1", "freeze");
  await expect(row(two)).toHaveAttribute("data-rollup", "blocked");
  await activity(state, "tstv1-worktree-1", "release");
  await expect(row(two)).toHaveAttribute("data-rollup", "finished");
  await page.reload();
  await visibleOnScreen(
    row(two).locator(".otk-status-light[data-state=finished]"),
  );
});
