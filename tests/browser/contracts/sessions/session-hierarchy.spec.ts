// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { activity, collapsed, visibleOnScreen } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-family" });
test("sessions.hierarchy-cross-checkout-mandatory-root-and-task-scope", {
  tag: ["@sessions", "@attention", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  const { entries } = await state.observe<
    { entries: { id: string; directory: string }[] }
  >();
  const child = "tstv1-family-0", root = "tstv1-otk";
  const directory = entries.find((entry) => entry.id === child)!.directory;
  const task =
    (await state.product("tasks.list", { directory: state.directory }))[0];
  const tab = (id: string) => page.locator(`[data-tab=${JSON.stringify(id)}]`);
  const orientation = async (
    anchor: string,
    session: string,
    title: string,
  ) => {
    const selected = tab(anchor);
    await visibleOnScreen(selected);
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('.otk-task-list [aria-selected="true"]'))
      .toHaveCount(1);
    const current = page.locator(
      `[data-open-session=${JSON.stringify(session)}]`,
    );
    await visibleOnScreen(current);
    await expect(current.locator(".otk-control-label")).toHaveText(title);
    const geometry = await current.evaluate((node) => {
      const strip = node.closest(".otk-task-strip")!;
      const active = strip.querySelector('[role="tab"][aria-selected="true"]')!;
      const a = active.getBoundingClientRect(),
        n = node.getBoundingClientRect(),
        s = strip.getBoundingClientRect();
      const label = node.querySelector(".otk-control-label")!;
      return {
        fontStyle: getComputedStyle(active).fontStyle,
        currentStyle: getComputedStyle(label).fontStyle,
        centered: Math.abs(a.y + a.height / 2 - n.y - n.height / 2),
        contained: n.left >= s.left && n.right <= s.right && n.top >= s.top &&
          n.bottom <= s.bottom,
        labelFits: label.scrollWidth <= label.clientWidth + 1,
      };
    });
    expect(geometry).toEqual({
      fontStyle: "normal",
      currentStyle: "normal",
      centered: 0,
      contained: true,
      labelFits: true,
    });
  };
  const capture = async (
    stateName: string,
    anchor?: string,
    session?: string,
    title?: string,
  ) => {
    for (
      const [theme, label] of [["otk-dark", "dark"], ["otk-light", "linen"], [
        "otk-light-stone",
        "stone",
      ]]
    ) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      if (anchor && session && title) await orientation(anchor, session, title);
      await page.screenshot({
        path: info.outputPath(`sh1-${label}-${stateName}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
  };
  await state.product("layout.patch", {
    leftCollapsed: true,
    rightCollapsed: true,
  });
  await page.goto(state.url);
  // Use the ordinary project route exposed by the rail, never a fixture hook.
  await page.locator(
    `.otk-project-row[data-project=${
      JSON.stringify(directory)
    }] .otk-project-open`,
  ).click();
  await visibleOnScreen(tab(child));
  await page.reload();
  await collapsed(page);
  await visibleOnScreen(tab(child));
  await expect(tab(child).locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "working",
  );
  await activity(state, child, "freeze");
  await expect(tab(child).locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "blocked",
  );
  await page.reload();
  await collapsed(page);
  await visibleOnScreen(tab(child));
  await activity(state, child, "release");
  await expect(tab(child).locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "finished",
  );
  await page.reload();
  await visibleOnScreen(tab(child));
  await tab(child).click();
  await expect(page).toHaveURL(new RegExp(`${root}/${child}$`));
  await orientation(child, child, "Moved child");
  await expect(tab(root)).toHaveCount(0);
  const parentLink = page.getByRole("link", { name: "Execution", exact: true });
  await expect(parentLink).toHaveAttribute("href", `#/local/${root}`);
  await expect(tab(task.id)).toHaveCount(0);
  await activity(state, child, "hold");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/tstv1-otk\/tstv1-family-1$/);
  await orientation(task.id, "tstv1-family-1", "Local sibling");
  await page.reload();
  await orientation(task.id, "tstv1-family-1", "Local sibling");
  await capture("repo", task.id, "tstv1-family-1", "Local sibling");
  await page.getByRole("button", { name: "Prev", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${root}/${child}$`));
  await orientation(child, child, "Moved child");
  await parentLink.click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  await page.goto(`${state.url}/#/local/${root}/${child}`);
  await orientation(child, child, "Moved child");
  await capture("local", child, child, "Moved child");
  await page.locator(".otk-settings-entry").click();
  const toggle = page.getByRole("checkbox", {
    name: "Tasks follow their parent across projects",
  });
  await expect(toggle).not.toBeChecked();
  const projects = page.getByRole("region", {
    name: "Project settings",
    exact: true,
  });
  await expect(
    projects.getByRole("checkbox", {
      name: "Tasks follow their parent across projects",
    }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "Appearance settings", exact: true })
      .getByRole("checkbox", {
        name: "Tasks follow their parent across projects",
      }),
  ).toHaveCount(0);
  // Controls wait for the authoritative preference broadcast, not optimistic DOM.
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(async () =>
    (await state.product("prefs.get", {})).tasksFollowParent
  ).toBe(true);
  for (
    const [theme, label] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await toggle.scrollIntoViewIfNeeded();
    await toggle.focus();
    await page.screenshot({
      path: info.outputPath(`sh1-${label}-settings.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.getByRole("button", { name: "Close settings", exact: true })
    .click();
  await visibleOnScreen(tab(task.id));
  await expect(tab(task.id)).toHaveAttribute("aria-selected", "true");
  await expect(tab(child)).toHaveCount(0);
  await visibleOnScreen(page.locator(`[data-crumb=${child}]`));
  await page.reload();
  await collapsed(page);
  await visibleOnScreen(tab(task.id));
  await expect(tab(task.id)).toHaveAttribute("aria-selected", "true");
  await orientation(task.id, child, "Moved child");
  await capture("follow", task.id, child, "Moved child");
  await state.product("prefs.set", { key: "tasksFollowParent", value: false });
  await visibleOnScreen(tab(child));
  await orientation(child, child, "Moved child");
  await expect(tab(root)).toHaveCount(0);
});
