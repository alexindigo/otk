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
  // Archive is separate from manual Inactive; working/blocked rows stay live.
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
  const repositoryTree = row(canonical).locator(
    "xpath=ancestor::section[contains(@class, 'otk-project-tree')][1]",
  );
  const repositoryToggle = repositoryTree.locator(
    ":scope > .otk-tree-heading .otk-tree-toggle",
  );
  await repositoryToggle.press("ArrowLeft");
  await expect(repositoryToggle).toHaveAttribute("aria-expanded", "false");
  await visibleOnScreen(archive);
  await visibleOnScreen(row(two));
  await expect(archive).toHaveAttribute("aria-expanded", "true");
  await repositoryToggle.press("ArrowRight");
  await expect(repositoryToggle).toHaveAttribute("aria-expanded", "true");
  for (const directory of [one, two]) {
    await visibleOnScreen(row(directory));
    await expect(row(directory)).toHaveAttribute(
      "data-project-parent",
      canonical,
    );
    const rollup = await row(directory).getAttribute("data-rollup");
    const live = rollup === "working" || rollup === "blocked";
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
    await expect(row(directory).locator(".otk-project-open"))
      .toHaveAccessibleName(/\(removed\)$/);
    await expect(row(directory).locator(".otk-project-open"))
      .toHaveAttribute("title", /\(removed\)$/);
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
  // An unseen finish is archived, but its header lamp/count stay visible.
  await expect(row(two)).toHaveCount(0);
  await visibleOnScreen(
    archive.locator(".otk-status-light[data-state=finished]"),
  );
  await expect(archive).toHaveAttribute("data-unseen-count", "1");
  await state.product("layout.patch", { leftCollapsed: false });
  await page.reload();
  await expect(row(two)).toHaveCount(0);
  await expect(archive).toHaveAttribute("aria-expanded", "false");
  await visibleOnScreen(
    archive.locator(".otk-status-light[data-state=finished]"),
  );
  await expect(archive.locator(".otk-archived-count")).toHaveText("(1)");
  await expect(archive).toHaveAccessibleName(/1 unseen$/);
  await expect(archive).toHaveAttribute("title", /1 unseen$/);
  await expect(archive.locator(".otk-archived-unseen")).toHaveCount(0);
  await archive.click();
  await expect(row(two)).toHaveAttribute("data-rollup", "finished");
  await expect(row(two)).toHaveAttribute("data-group", "archived");
  await visibleOnScreen(
    row(two).locator(".otk-status-light[data-state=finished]"),
  );
  for (
    const [theme, label] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    const alignment = await archive.evaluate((element) => {
      const selectors = [
        ".otk-status-light",
        ".otk-control-label",
        ".otk-archived-count",
      ];
      return selectors.map((selector) => {
        const box = element.querySelector(selector)!.getBoundingClientRect();
        return box.y + box.height / 2;
      });
    });
    expect(Math.max(...alignment) - Math.min(...alignment)).toBeLessThanOrEqual(
      1,
    );
    const nesting = await page.evaluate(({ one, two }) => {
      const live = document.querySelector(
        `.otk-project-row[data-project="${one}"] .otk-status-light`,
      )!.getBoundingClientRect();
      const header = document.querySelector(
        ".otk-archived-toggle .otk-status-light",
      )!.getBoundingClientRect();
      const archived = document.querySelector(
        `.otk-project-row[data-project="${two}"] .otk-status-light`,
      )!.getBoundingClientRect();
      const toggle = document.querySelector(".otk-archived-toggle")!
        .getBoundingClientRect();
      const count = document.querySelector(".otk-archived-count")!
        .getBoundingClientRect();
      const tree = document.querySelector(".otk-archive-tree")!;
      const heading = tree.querySelector(":scope > .otk-tree-heading")!;
      const child = document.querySelector(
        `.otk-project-row[data-project="${two}"]`,
      )!.closest(".otk-tree-node")!;
      const junction = child.querySelector(
        ":scope > .otk-tree-heading > .otk-tree-own",
      )!.getBoundingClientRect();
      const parent = tree.parentElement!.closest(".otk-project-tree")!;
      return {
        live: live.x + live.width / 2,
        header: header.x + header.width / 2,
        archived: archived.x + archived.width / 2,
        countRight: count.right,
        headerRight: toggle.right,
        indent: parseFloat(getComputedStyle(heading).gridTemplateColumns),
        sharedHeader: tree.classList.contains("is-connected"),
        sharedChild: child.classList.contains("is-connected"),
        childJunction: junction.x + junction.width / 2,
        repository: parent.querySelector(".otk-project-row")?.getAttribute(
          "data-project",
        ),
      };
    }, { one, two });
    expect(Math.abs(nesting.live - nesting.header)).toBeLessThanOrEqual(1);
    expect(nesting.archived).toBeGreaterThan(nesting.header);
    expect(nesting.sharedHeader).toBe(true);
    expect(nesting.sharedChild).toBe(true);
    expect(nesting.repository).toBe(canonical);
    expect(Math.abs(nesting.archived - nesting.header - nesting.indent))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(nesting.childJunction - nesting.header))
      .toBeLessThanOrEqual(1);
    expect(nesting.countRight).toBeLessThanOrEqual(nesting.headerRight);
    await page.screenshot({
      path: info.outputPath(`wp12-combined-sidebar-${label}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await row(two).locator(".otk-project-open").click();
  await expect(row(two)).toHaveAttribute("data-group", "archived");
  await expect(row(two)).toHaveAttribute("data-rollup", "none");
  await expect(archive).toHaveAccessibleName(/0 unseen$/);
  await expect(archive.locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "none",
  );
});
