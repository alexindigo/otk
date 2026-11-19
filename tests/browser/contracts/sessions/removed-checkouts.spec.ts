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
  // Archive is separate from manual Inactive; all mandatory lamps stay live.
  const archive = page.locator(".otk-archived-toggle");
  await expect(archive).toHaveAttribute("aria-expanded", "false");
  const liveBounds = await row(one).boundingBox();
  const archiveBounds = await archive.boundingBox();
  expect(liveBounds).not.toBeNull();
  expect(archiveBounds).not.toBeNull();
  expect(archiveBounds!.y).toBeGreaterThanOrEqual(
    liveBounds!.y + liveBounds!.height,
  );
  await expect(row(two)).toHaveCount(0);
  await archive.click();
  for (const directory of [one, two]) {
    await visibleOnScreen(row(directory));
    await expect(row(directory)).toHaveAttribute(
      "data-project-parent",
      canonical,
    );
    const rollup = await row(directory).getAttribute("data-rollup");
    const live = rollup !== "none";
    await expect(row(directory)).toHaveAttribute(
      "data-group",
      live ? "active" : "archived",
    );
    await expect(page.locator(".otk-archived-projects").locator(row(directory)))
      .toHaveCount(live ? 0 : 1);
    await expect(row(directory)).toHaveAttribute(
      "data-project-availability",
      "removed",
    );
    await expect(row(directory).locator(".otk-project-availability"))
      .toHaveText("removed");
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
  await archive.click();
  await visibleOnScreen(row(two));
  await expect(row(two)).toHaveAttribute("data-group", "archived");
  for (const inactive of [true, false]) {
    await state.product("projects.inactive", { directory: two, inactive });
    await expect(row(two)).toHaveAttribute("data-group", "archived");
    await expect(row(two)).toHaveAttribute("data-project-archived", "true");
    await expect(page.locator(".otk-inactive-projects").locator(row(two)))
      .toHaveCount(0);
  }
  for (
    const [theme, label] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    for (const directory of [one, two]) {
      const geometry = await row(directory).evaluate((element) => {
        const name = element.querySelector(".otk-project-name")!
          .getBoundingClientRect();
        const label = element.querySelector(".otk-project-availability")!
          .getBoundingClientRect();
        return {
          nameCenter: name.y + name.height / 2,
          labelCenter: label.y + label.height / 2,
          height: element.getBoundingClientRect().height,
        };
      });
      expect(Math.abs(geometry.nameCenter - geometry.labelCenter))
        .toBeLessThanOrEqual(1);
      expect(geometry.height).toBe(32);
    }
    await page.screenshot({
      path: info.outputPath(`ph1-${label}-removed.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await archive.click();
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
  // An unseen finish stays live in the rail and after reload, not in archive.
  await expect(row(two)).toHaveAttribute("data-rollup", "finished");
  await expect(row(two)).toHaveAttribute("data-group", "active");
  await state.product("layout.patch", { leftCollapsed: false });
  await page.reload();
  await expect(row(two)).toHaveAttribute("data-rollup", "finished");
  await expect(row(two)).toHaveAttribute("data-group", "active");
  await visibleOnScreen(
    row(two).locator(".otk-status-light[data-state=finished]"),
  );
  await row(two).locator(".otk-project-open").click();
  await expect(row(two)).toHaveCount(0);
  await archive.click();
  await expect(row(two)).toHaveAttribute("data-group", "archived");
  await expect(row(two)).toHaveAttribute("data-rollup", "none");
});
