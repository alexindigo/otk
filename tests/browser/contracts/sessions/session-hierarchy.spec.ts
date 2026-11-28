// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { activity, collapsed, visibleOnScreen } from "../../pages/sessions.ts";

const child = "tstv1-family-0", root = "tstv1-otk";
const tabSelector = (id: string) => `[data-tab=${JSON.stringify(id)}]`;
async function parentTask(state: TestState) {
  const tasks = (await state.product("tasks.list", {
    directory: state.directory,
  })).filter((task) => task.sessions.includes(root));
  expect(tasks).toHaveLength(1);
  return tasks[0];
}

test.use({ profile: "contract-sessions-family" });
test("sessions.helper-only-group-has-no-task-tab", {
  tag: ["@sessions", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  const task = await parentTask(state);
  const { entries } = await state.observe<
    { entries: { id: string; directory: string }[] }
  >();
  const directory = entries.find((entry) => entry.id === child)!.directory;
  const helperOnly = await state.product("tasks.create", {
    directory,
    name: "Legacy helper-only group",
    sessions: [child],
  });
  expect(helperOnly.sessions).toEqual([child]);
  await page.goto(`${state.url}/#/local/${root}/${child}`);
  await expect(page.locator(tabSelector(task.id))).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(tabSelector(helperOnly.id)))
    .toHaveCount(0);
  await expect(page.locator(tabSelector(root))).toHaveCount(0);
  await expect(page.locator(tabSelector(child))).toHaveCount(0);
  await expect(page.locator(`[data-crumb=${child}]`)).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("sessions.hierarchy-cross-checkout-mandatory-root-and-task-scope", {
  tag: ["@sessions", "@attention", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  const { entries } = await state.observe<
    { entries: { id: string; directory: string }[] }
  >();
  const directory = entries.find((entry) => entry.id === child)!.directory;
  const task = await parentTask(state);
  const tab = (id: string) => page.locator(tabSelector(id));
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
      `[data-crumb=${JSON.stringify(session)}]`,
    );
    await visibleOnScreen(current);
    await expect(current.locator(".otk-trail-title")).toHaveText(title);
    await expect(page.locator(".otk-open-session-title")).toHaveCount(0);
    await expect(current).toHaveAttribute("aria-current", "page");
    const geometry = await current.evaluate((node) => {
      const strip = node.closest(".otk-breadcrumb-row")!;
      const active = node.closest(".otk-project-tabs")!.querySelector(
        '[role="tab"][aria-selected="true"]',
      )!;
      const a = node.querySelector(".otk-status-light")!
          .getBoundingClientRect(),
        n = node.querySelector(".otk-trail-title")!.getBoundingClientRect(),
        s = strip.getBoundingClientRect();
      const label = node.querySelector(".otk-trail-title")!;
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
  // 2.47: an explicit checkout/attention target retains its helper identity.
  // D69/D70: the exact helper view lives in its parent's saved task even
  // across checkouts; the task lamp aggregates its entire session subtree.
  // The repository's default and explicit parent link still resolve the root.
  await page.locator(
    `.otk-project-row[data-project=${
      JSON.stringify(directory)
    }] .otk-sidebar-lamp-action`,
  ).click();
  await expect(page).toHaveURL(new RegExp(`${child}$`));
  await page.goto(`${state.url}/#/local/${root}/${child}`);
  await orientation(task.id, child, "Moved child");
  await page.reload();
  await collapsed(page);
  await orientation(task.id, child, "Moved child");
  const taskLamp = tab(task.id).locator(".otk-status-light");
  await expect(taskLamp).toHaveAttribute(
    "data-state",
    "working",
  );
  await activity(state, child, "freeze");
  await expect(taskLamp).toHaveAttribute(
    "data-state",
    "blocked",
  );
  await page.reload();
  await collapsed(page);
  await orientation(task.id, child, "Moved child");
  await activity(state, child, "release");
  await expect(taskLamp).toHaveAttribute(
    "data-state",
    "finished",
  );
  await page.reload();
  await orientation(task.id, child, "Moved child");
  const parentLink = page.getByRole("link", { name: "Execution", exact: true });
  await parentLink.click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  await orientation(task.id, root, "Execution");
  await page.goto(`${state.url}/#/local/${root}/${child}`);
  await orientation(task.id, child, "Moved child");
  await expect(tab(child)).toHaveCount(0);
  await expect(parentLink).toHaveAttribute("href", `#/local/${root}`);
  await expect(tab(root)).toHaveCount(0);
  await activity(state, child, "hold");
  await page.goto(`${state.url}/#/local/${root}/tstv1-family-1`);
  await orientation(task.id, "tstv1-family-1", "Local sibling");
  await page.reload();
  await orientation(task.id, "tstv1-family-1", "Local sibling");
  await capture("repo", task.id, "tstv1-family-1", "Local sibling");
  await page.goto(`${state.url}/#/local/${root}/${child}`);
  await orientation(task.id, child, "Moved child");
  await parentLink.click();
  await expect(page).toHaveURL(new RegExp(`${root}$`));
  await orientation(task.id, root, "Execution");
  await page.goto(`${state.url}/#/local/${root}/${child}`);
  await orientation(task.id, child, "Moved child");
  await capture("local", task.id, child, "Moved child");
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
  await expect.poll(async () =>
    (await state.product("prefs.get", {})).tasksFollowParent
  ).toBe(false);
  await orientation(task.id, child, "Moved child");
  await expect(tab(root)).toHaveCount(0);
  await expect(tab(child)).toHaveCount(0);
});
