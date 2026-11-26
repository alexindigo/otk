// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator, Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

const tag = ["@sessions", "@contracts", "@isolated"];
const rootID = "tstv1-otk";
const row = (page: Page, id: string) => page.locator(`[data-session=${id}]`);
const node = (locator: Locator) =>
  locator.locator("xpath=ancestor::section[@data-tree-node][1]");
const toggle = (locator: Locator) =>
  node(locator).locator(":scope > .otk-tree-heading button.otk-tree-toggle");
const taskToggle = (page: Page) =>
  page.getByRole("button", { name: /^Execution,/ });
const ungrouped = (page: Page) =>
  page.getByRole("button", { name: /^Not in a task,/ });

async function geometry(locator: Locator) {
  return await locator.evaluate((node) => {
    const heading = node.querySelector(":scope > .otk-tree-heading")!;
    const rect = (selector: string) =>
      heading.querySelector(selector)?.getBoundingClientRect();
    const probe = document.createElement("span");
    probe.style.position = "absolute";
    heading.append(probe);
    const token = (name: string) => {
      probe.style.width = `var(${name})`;
      return probe.getBoundingClientRect().width;
    };
    const indent = token("--tree-indent"),
      height = token("--row-project"),
      box = token("--tree-box-size"),
      unit = token("--otk-unit");
    probe.remove();
    const own = rect(":scope > .otk-tree-own")!,
      toggle = rect(":scope > .otk-tree-own .otk-tree-toggle"),
      lamp = rect(".otk-tree-icon .otk-status-light"),
      label = rect(
        ".otk-project-name, .otk-session-title, .otk-section-row-label",
      )!;
    return {
      indent,
      height,
      box,
      unit,
      headingHeight: heading.getBoundingClientRect().height,
      own: { x: own.x, cx: own.x + own.width / 2, cy: own.y + own.height / 2 },
      toggle: toggle &&
        {
          cx: toggle.x + toggle.width / 2,
          cy: toggle.y + toggle.height / 2,
          width: toggle.width,
          height: toggle.height,
        },
      lamp: lamp &&
        { cx: lamp.x + lamp.width / 2, width: lamp.width, height: lamp.height },
      labelInset: label.x - own.x,
    };
  });
}

const within = (actual: number, expected: number, tolerance = 0.5) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

function assertSharedTrack(g: Awaited<ReturnType<typeof geometry>>) {
  within(g.headingHeight, g.height);
  if (g.toggle) {
    within(g.toggle.width, g.box, 1);
    within(g.toggle.height, g.box, 1);
    within(g.toggle.cx, g.own.cx);
    within(g.toggle.cy, g.own.cy);
  }
  if (g.lamp) {
    within(g.lamp.width, 10 * g.unit);
    within(g.lamp.height, 10 * g.unit);
  }
}

test.describe("left and right tracks", () => {
  test.use({ profile: "contract-sessions-worktrees" });
  test(
    "sessions.one-tree-geometry-matches-left",
    { tag },
    async ({ isolatedState: state, page }) => {
      const task = await state.product("tasks.create", {
        directory: state.directory,
        name: "Execution",
        sessions: [rootID],
      });
      await openSession(state, page, rootID);
      const left = page.locator(".otk-project-inbox");
      const parent = left.locator(
        `[data-project=${JSON.stringify(state.directory)}]`,
      );
      const child = left.locator(".otk-project-row.is-subproject").first();
      const header = node(taskToggle(page));
      await expect(header).toHaveClass(/is-flat/);
      await expect(child).toBeVisible();
      await expect(row(page, rootID)).toBeVisible();
      const [lp, lc, rh, rc] = await Promise.all([
        geometry(node(parent)),
        geometry(node(child)),
        geometry(header),
        geometry(node(row(page, rootID))),
      ]);
      for (const g of [lp, lc, rh, rc]) assertSharedTrack(g);
      expect(lp.lamp).toBeDefined();
      expect(rh.lamp).toBeDefined();
      within(lc.own.cx, lp.lamp!.cx);
      within(rc.own.cx, rh.lamp!.cx);
      within(lc.own.x - lp.own.x, lp.indent);
      within(rc.own.x - rh.own.x, rh.indent);
      within(rc.labelInset, lc.labelInset);
      const inactive = left.locator(".otk-inactive-toggle");
      await expect(inactive).toBeVisible();
      const lh = await geometry(node(inactive));
      assertSharedTrack(lh);
      within(rh.labelInset, lh.labelInset);
      await expect(
        page.locator(`[data-session-group=${JSON.stringify(task.id)}]`),
      ).toBeVisible();
    },
  );
});

test.describe("virtual session trees", () => {
  test.use({ profile: "contract-sessions-hierarchy" });
  test.beforeEach(async ({ isolatedState: state, page }) => {
    await state.product("tasks.create", {
      directory: state.directory,
      name: "Execution",
      sessions: [rootID],
    });
    await openSession(state, page, rootID);
    await expect(row(page, "tstv1-nested")).toBeVisible();
  });

  test("sessions.one-tree-keyboard", { tag }, async ({ page }) => {
    const execution = row(page, rootID), button = toggle(execution);
    const helper = row(page, "tstv1-helper"),
      nested = row(page, "tstv1-nested");
    const [root, child, grandchild] = await Promise.all([
      geometry(node(execution)),
      geometry(node(helper)),
      geometry(node(nested)),
    ]);
    for (const g of [root, child, grandchild]) assertSharedTrack(g);
    within(child.own.cx, root.lamp!.cx);
    within(grandchild.own.cx, child.lamp!.cx);
    await button.press("ArrowLeft");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(helper).toHaveCount(0);
    await expect(nested).toHaveCount(0);
    await button.press("ArrowRight");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(nested).toBeVisible();
    await button.press("Tab");
    await expect(execution.locator(".otk-session-open")).toBeFocused();
    const task = taskToggle(page);
    await task.press("ArrowLeft");
    await expect(task).toHaveAttribute("aria-expanded", "false");
    for (const member of [execution, helper, nested]) {
      await expect(member).toHaveCount(0);
    }
    await task.press("ArrowRight");
    await expect(task).toHaveAttribute("aria-expanded", "true");
    await expect(nested).toBeVisible();
  });

  test(
    "sessions.one-tree-collapse-persists",
    { tag },
    async ({ isolatedState: state, page }) => {
      const execution = row(page, rootID), childToggle = toggle(execution);
      const task = taskToggle(page), heading = ungrouped(page);
      const taskLamp = task.locator(".otk-status-light");
      const lamp = execution.locator(".otk-status-light");
      const attention = [
        await taskLamp.getAttribute("data-state"),
        await lamp.getAttribute("data-state"),
      ];
      await task.press("ArrowLeft");
      await expect(execution).toHaveCount(0);
      await expect(taskLamp).toHaveAttribute("data-state", attention[0]!);
      await task.press("ArrowRight");
      await expect(lamp).toHaveAttribute("data-state", attention[1]!);
      await childToggle.click();
      await heading.click();
      const saved = async () =>
        (await state.product("prefs.get", {})).shellLayout.treeCollapsed;
      await expect.poll(saved).toEqual({
        [JSON.stringify(["local", "session", rootID])]: true,
        [JSON.stringify(["local", "ungrouped", state.directory])]: true,
      });
      const assertClosed = async () => {
        await expect(childToggle).toHaveAttribute("aria-expanded", "false");
        await expect(heading).toHaveAttribute("aria-expanded", "false");
        await expect(row(page, "tstv1-helper")).toHaveCount(0);
        await expect(row(page, "tstv1-preview")).toHaveCount(0);
      };
      await page.reload();
      await assertClosed();
      const { entries } = await state.observe<
        { entries: { directory: string }[] }
      >();
      const other =
        entries.find((entry) => entry.directory !== state.directory)!.directory;
      await state.product("projects.visit", { directory: other, active: true });
      const project = (path: string) =>
        page.locator(
          `[data-project=${JSON.stringify(path)}] .otk-project-open`,
        );
      await project(other).click();
      await expect(page.locator(".otk-project-sessions")).toHaveAttribute(
        "data-session-project",
        other,
      );
      await project(state.directory).click();
      await assertClosed();
      await childToggle.click();
      await heading.click();
      await expect.poll(saved).toEqual({});
      await expect(row(page, "tstv1-nested")).toBeVisible();
    },
  );

  test(
    "sessions.one-tree-keeps-right-panel-facts",
    { tag },
    async ({ page }) => {
      await expect(taskToggle(page)).toHaveAccessibleName("Execution, 3");
      const execution = row(page, rootID);
      await expect(execution).toHaveAttribute("aria-current", "page");
      await expect(execution).toHaveClass(/\bis-selected\b/);
      await expect(
        node(execution).locator(
          ":scope > .otk-tree-heading .otk-tree-selection-mark",
        ),
      ).toBeVisible();
      await expect(execution).toContainText("Pending");
      await expect(row(page, "tstv1-blocked")).toContainText(/Q\s*1/);
      const search = page.getByRole("searchbox", {
        name: "Search sessions by title",
      });
      await search.fill("references");
      await expect(page.locator(".otk-session-row[data-session]")).toHaveCount(
        3,
      );
      await expect(row(page, "tstv1-nested")).toBeVisible();
      await expect(toggle(execution)).toBeVisible();
      await toggle(execution).press("ArrowLeft");
      await expect(row(page, "tstv1-nested")).toHaveCount(0);
      await expect(taskToggle(page)).toHaveAccessibleName("Execution, 3");
      await toggle(execution).press("ArrowRight");
      await expect(row(page, "tstv1-nested")).toBeVisible();
      await search.fill("");
      const preview = row(page, "tstv1-preview");
      await preview.click();
      await expect(page.locator(".otk-tab[data-preview=true]")).toContainText(
        "Idle preview",
      );
      await preview.dblclick();
      await expect(
        page.locator(".otk-tab[data-kind=task]").filter({
          hasText: "Idle preview",
        }),
      ).toBeVisible();
    },
  );
});
