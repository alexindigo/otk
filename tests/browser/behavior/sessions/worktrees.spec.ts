// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { activity, visibleOnScreen } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-worktrees" });
test("sessions.worktree-hierarchy-leaf-archive-auto-return-and-rail-geometry", {
  tag: ["@sessions", "@projects", "@attention", "@visual", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  const { root, entries } = await state.observe<
    { root: string; entries: { id: string; directory: string }[] }
  >();
  const canonical = entries[0].directory;
  const one = root + "/worktrees/feature-one",
    two = root + "/worktrees/feature-two",
    archived = root + "/worktrees/archived-tree";
  const row = (directory: string) =>
    page.locator(`.otk-project-row[data-project=${JSON.stringify(directory)}]`);
  await page.goto(state.url);
  await expect(row(one)).toHaveAttribute("data-rollup", "working");
  await expect(row(canonical)).toHaveAttribute("data-rollup", "working");
  await expect(row(two)).toHaveAttribute("data-rollup", "idle");
  await expect(row(one)).toHaveAttribute("data-project-parent", canonical);
  await row(one).locator(".otk-project-open").click();
  await visibleOnScreen(page.locator("[data-kind=phantom]").first());
  await expect(row(one + "/src")).toHaveCount(0);
  await expect(row(one)).toHaveClass(/is-selected/);
  await expect(page.locator(".otk-tab-open").filter({ hasText: "Nested task" }))
    .toBeVisible();
  await state.product("layout.patch", {
    rightCollapsed: false,
    rightView: "sessions",
  });
  await expect(page.locator(".otk-project-sessions")).toHaveAttribute(
    "data-session-project",
    one,
  );
  await visibleOnScreen(
    page.locator(".otk-project-sessions [data-session=tstv1-worktree-0]"),
  );
  await visibleOnScreen(
    page.locator(".otk-project-sessions [data-session=tstv1-worktree-task]"),
  );
  await page.locator(".otk-tab-open").filter({ hasText: "Nested task" })
    .click();
  await expect(page).toHaveURL(/tstv1-worktree-task$/);
  await expect(row(one)).toHaveClass(/is-selected/);
  expect(
    (await state.product("tasks.list", { directory: one + "/src" }))[0]
      .directory,
  ).toBe(one + "/src");
  await page.locator("[data-tab=tstv1-worktree-0]").click();
  await page.reload();
  await expect(row(one)).toHaveClass(/is-selected/);
  await expect(row(one + "/src")).toHaveCount(0);
  await visibleOnScreen(page.locator("[data-tab=tstv1-worktree-0]"));
  await page.locator(".otk-inactive-toggle").click();
  await expect(row(archived)).toHaveAttribute("data-inactive", "true");
  await expect(row(archived).locator(".otk-project-parent")).toHaveText("otk");
  for (
    const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await page.locator(".otk-inactive-toggle").click();
    await expect(row(archived)).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`v6a-${name}-active.png`),
      fullPage: true,
    });
    await page.locator(".otk-inactive-toggle").click();
    const geometry = await page.locator(".otk-project-row[data-project-repo]")
      .evaluateAll((rows) =>
        rows.map((row) => {
          const box = row.getBoundingClientRect();
          const name = row.querySelector(".otk-project-name")!
            .getBoundingClientRect();
          const light = row.querySelector(".otk-status-light")!
            .getBoundingClientRect();
          return {
            directory: row.getAttribute("data-project"),
            x: name.x,
            height: box.height,
            center: box.y + box.height / 2,
            light: light.y + light.height / 2,
          };
        })
      );
    const parent = geometry.find((r) => r.directory === canonical)!;
    const first = geometry.find((r) => r.directory === one)!;
    const second = geometry.find((r) => r.directory === two)!;
    expect(first.x).toBeGreaterThan(parent.x);
    expect(first.x).toBe(second.x);
    for (const r of geometry) {
      expect(Math.abs(r.center - r.light)).toBeLessThanOrEqual(1);
      expect(r.height).toBe(32);
    }
    await page.screenshot({
      path: info.outputPath(`v6a-${name}-inactive.png`),
      fullPage: true,
    });
    await page.locator(".otk-project-inbox").screenshot({
      path: info.outputPath(`review-${name}-column.png`),
    });
    const centers = await row(one).locator(".otk-status-light").boundingBox();
    await page.getByRole("button", { name: "Collapse projects", exact: true })
      .click();
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await visibleOnScreen(
      row(one).locator(".otk-status-light[data-state=working]"),
    );
    await visibleOnScreen(page.locator("[data-kind=phantom]").first());
    const rail = await row(one).locator(".otk-status-light").boundingBox();
    expect(rail!.y + rail!.height / 2).toBe(centers!.y + centers!.height / 2);
    await page.screenshot({
      path: info.outputPath(`v6a-${name}-rail.png`),
      fullPage: true,
    });
    await page.locator(".otk-project-inbox").screenshot({
      path: info.outputPath(`review-${name}-rail.png`),
    });
    await page.getByRole("button", { name: "Expand projects", exact: true })
      .click();
  }
  await page.locator(".otk-inactive-toggle").click();
  await expect(row(archived)).toHaveCount(0);
  await activity(state, "tstv1-worktree-2", "hold");
  await visibleOnScreen(row(archived));
  await expect(row(archived)).toHaveAttribute("data-inactive", "false");
  expect(
    (await state.product("inbox.get", {})).inbox.projects.find((p) =>
      p.directory === archived
    )?.inactive,
  ).toBe(false);
  await state.product("projects.inactive", { directory: two, inactive: true });
  await page.reload();
  await visibleOnScreen(
    row(archived).locator(".otk-status-light[data-state=working]"),
  );
  await expect(row(two)).toHaveCount(0);
  await state.product("layout.patch", {
    leftCollapsed: true,
    rightCollapsed: true,
  });
  await page.reload();
  await visibleOnScreen(
    row(one).locator(".otk-status-light[data-state=working]"),
  );
  await visibleOnScreen(
    row(archived).locator(".otk-status-light[data-state=working]"),
  );
  await activity(state, "tstv1-worktree-2", "freeze");
  await expect(row(archived)).toHaveAttribute("data-rollup", "blocked");
  await activity(state, "tstv1-worktree-2", "release");
  await expect(row(archived)).toHaveAttribute("data-rollup", "finished");
  await page.reload();
  await visibleOnScreen(
    row(archived).locator(".otk-status-light[data-state=finished]"),
  );
  await state.product("sessions.seen", { sessionID: "tstv1-worktree-2" });
  await activity(state, "tstv1-worktree-0", "release");
  await state.product("sessions.seen", { sessionID: "tstv1-worktree-0" });
  await expect(row(canonical)).toHaveAttribute("data-rollup", "idle");
  await state.product("projects.inactive", {
    directory: canonical,
    inactive: true,
  });
  await state.product("layout.patch", { leftCollapsed: false });
  await visibleOnScreen(row(canonical));
  await expect(row(canonical)).toHaveAttribute("data-group", "active");
  expect(
    (await state.product("inbox.get", {})).inbox.projects.find((p) =>
      p.directory === canonical
    )?.inactive,
  ).toBe(true);
  await row(canonical).locator(".otk-project-menu > button").click();
  await page.getByRole("menuitem", { name: "Mark active", exact: true })
    .click();
  expect(
    (await state.product("inbox.get", {})).inbox.projects.find((p) =>
      p.directory === canonical
    )?.inactive,
  ).toBe(false);
});
