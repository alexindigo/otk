// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";
import { restorePermissionDock, subagents } from "../../pages/crumbs.ts";
import { prompt } from "../../pages/transcript.ts";

const sidebarMeta = ".otk-sidebar-meta .otk-meta-item:not([hidden])";
const titleSlot = "[data-row-title], .otk-sidebar-label";
const registry = [
  {
    id: "R1",
    row: ".otk-right-panel .otk-session-row",
    title: titleSlot,
    meta: `${sidebarMeta}, .otk-session-meta > *`,
    frame: true,
  },
  {
    id: "R2",
    row: ".otk-project-row",
    title: titleSlot,
    meta: sidebarMeta,
    frame: true,
  },
  {
    id: "R3",
    row: ".otk-right-panel .otk-section-tree .otk-section-header",
    title: ".otk-control-label",
    meta: sidebarMeta,
    frame: true,
  },
  {
    id: "R4",
    row: ".otk-timeline-row",
    title: titleSlot,
    meta: sidebarMeta,
    frame: true,
  },
  {
    id: "R5",
    row: ".otk-subagent-row",
    title: ".otk-subagent-name .otk-control-label",
    meta: ".otk-subagent-meta .otk-meta-item:not([hidden])",
  },
  {
    id: "R6",
    // Tree lanes separated the record disclosure caption from its facts.
    row: ".otk-revert-group .otk-record-group-heading",
    title: ".otk-revert-preview",
    meta: ".otk-record-row-status .otk-meta-item:not([hidden])",
  },
  {
    id: "R7",
    row: ".otk-composer-activity-line",
    title: ".otk-composer-task, .otk-composer-destination",
    meta: ".otk-composer-live-slot > :not([hidden])",
  },
  {
    id: "R8",
    row: ".otk-breadcrumb-row",
    title: ".otk-session-crumb.is-current .otk-trail-title",
    meta: ".otk-context-fit .otk-meta-item:not([hidden])",
  },
  {
    id: "R9",
    row: ".otk-tab, .otk-tabs-item",
    title: ".otk-tab-title, .otk-tabs-item [role=tab] .otk-control-label",
    meta: ".otk-meta-item:not([hidden])",
  },
];

async function inspect(page: Page, id: string, context: string) {
  const entry = registry.find((row) => row.id === id)!;
  const result = await page.locator(entry.row).evaluateAll(
    async (rows, entry) => {
      // Wait for the observer-driven fit after changing the viewport or mounting
      // a row; measure the layout the browser actually presents.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      const issues: string[] = [];
      let count = 0;
      let facts = 0;
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
          style.visibility === "visible" && style.opacity !== "0";
      };
      const measure = (el: Element, length: string) => {
        const probe = document.createElement("span");
        probe.style.cssText = `position:absolute;inline-size:${length}`;
        el.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      };
      for (const row of rows) {
        if (!visible(row)) continue;
        const titles = Array.from(row.querySelectorAll(entry.title)).filter(
          visible,
        );
        if (!titles.length) continue;
        count++;
        const frame = row.getBoundingClientRect();
        const meta = entry.meta
          ? Array.from(row.querySelectorAll(entry.meta)).filter(visible)
          : [];
        facts += meta.length;
        for (const title of titles) {
          const box = title.getBoundingClientRect();
          const width = box.width;
          const min = Math.min(
            measure(title, "var(--row-title-min, 12ch)"),
            title.scrollWidth,
            frame.width,
          );
          if (
            meta.length && title.scrollWidth > title.clientWidth + .5 &&
            width < min - 1
          ) {
            issues.push(`${title.textContent}: ${width} < min ${min}`);
          }
          if (entry.frame && box.right > frame.right + .5) {
            issues.push(`title escapes its row: ${title.textContent}`);
          }
        }
        for (const item of meta) {
          const box = item.getBoundingClientRect();
          if (
            item.clientWidth && item.scrollWidth > item.clientWidth + .5 ||
            box.right > frame.right + .5
          ) {
            issues.push(`meta cut: ${item.textContent?.trim()} (${box.width})`);
          }
          for (
            let clip = item.parentElement;
            clip && clip !== row;
            clip = clip.parentElement
          ) {
            if (
              getComputedStyle(clip).overflowX === "hidden" &&
              box.right > clip.getBoundingClientRect().right + .5
            ) {
              issues.push(`meta cut by container: ${item.textContent?.trim()}`);
              break;
            }
          }
        }
        if (entry.frame) {
          const last = Math.max(
            ...meta.map((el) => el.getBoundingClientRect().right),
          );
          const start =
            row.querySelector(".otk-tree-node-slot .otk-status-light") ??
              titles[0];
          if (frame.right - last < measure(row, "var(--space-2)") - .5) {
            issues.push(`trailing padding: ${frame.right - last}`);
          }
          if (
            start.getBoundingClientRect().left - frame.left <
              measure(row, "var(--space-1)") - .5
          ) {
            issues.push(
              `leading padding: ${
                start.getBoundingClientRect().left - frame.left
              }`,
            );
          }
        }
      }
      return { issues, count, facts };
    },
    entry,
  );
  expect.soft(result.count, `${id} ${context}: mounted titles`).toBeGreaterThan(
    0,
  );
  expect.soft(result.issues, `${id} ${context}`).toEqual([]);
  return result;
}

const themes = [["otk-dark", "dark"], ["otk-light", "linen"], [
  "otk-light-stone",
  "stone",
]] as const;

test.use({ profile: "isolated", timezoneId: "America/Los_Angeles" });
test("visual.row-title-min", { tag: ["@visual", "@isolated"] }, async (
  { isolatedState: state, page },
  info,
) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await state.product("layout.patch", {
    leftWidth: 200,
    leftCollapsed: false,
    rightWidth: 300,
    rightCollapsed: false,
    rightView: "sessions",
  });
  const parent = await seed(state, "Execution and dependency review");
  const child = await seed(
    state,
    "Validate the release configuration",
    parent.id,
  );
  await seed(state, "Review the reporting and evaluation contracts", parent.id);
  await seed(state, "Summarize the browser verification evidence", parent.id);
  await seed(state, "Confirm the transitive dependency inventory", child.id);
  await openSession(state, page, parent.id);
  await state.queue(["Dependency report complete."]);
  await prompt(
    page,
    "Inventory the dependencies in the release configuration.",
  );
  await expect(page.locator(".otk-messages")).toContainText(
    "Dependency report complete.",
  );
  await tool(state, "bash", {
    command: "printf review-dependencies",
    description: "Review dependencies",
  });
  await state.queue(["The configuration is ready."]);
  await state.native(`/session/${child.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Validate the release configuration" }],
  });
  const sessionRow = (id: string) =>
    page.locator(`.otk-right-panel [data-session="${id}"]`);
  const parentRow = sessionRow(parent.id);
  const childRow = sessionRow(child.id);
  await expect(parentRow).toContainText("Children 1");
  await expect(childRow).toContainText("P 1");
  await expect(parentRow).toHaveClass(/is-selected/);
  await page.locator(".otk-permission-dock").getByRole("button", {
    name: "Dismiss locally",
  }).click();
  const capture = async (name: string) => {
    if (process.env.OTK_ROW_META_CAPTURE) {
      await page.screenshot({
        path: info.outputPath(`${name}.png`),
        animations: "disabled",
      });
    }
  };
  // 280 is the persisted minimum. Drive narrower frames in the browser
  // without changing the layout contract or adding a production breakpoint.
  const setRightWidth = async (width: number) => {
    const rail = page.locator(".otk-right-panel");
    await rail.evaluate(
      (el, width) => (el as HTMLElement).style.width = `${width}px`,
      width,
    );
    await expect(rail).toHaveCSS("width", `${width}px`);
  };
  for (const scale of ["125", "100"]) {
    await state.product("prefs.set", { key: "textSize", value: scale });
    await expect(page.locator("html")).toHaveCSS(
      "--otk-scale",
      scale === "125" ? "1.25" : "1",
    );
    for (const width of [300, 230, 180, 300]) {
      const leftWidth = width === 300 ? 248 : 200;
      await state.product("layout.patch", { leftWidth });
      await expect(page.locator('.otk-sidebar-rail[data-side="left"]'))
        .toHaveCSS("width", `${leftWidth}px`);
      await setRightWidth(width);
      if (width === 230) {
        const search = page.getByRole("searchbox", {
          name: "Search sessions by title",
        });
        await expect(search).toHaveAttribute("placeholder", "Find a session");
        await expect(search).toHaveCSS("text-overflow", "ellipsis");
        expect(
          await search.evaluate((el) =>
            parseFloat(getComputedStyle(el).paddingInlineEnd)
          ),
        ).toBeGreaterThan(0);
      }
      await page.mouse.move(600, 500);
      const context = `${width}/${scale}`;
      const { facts } = await inspect(page, "R1", context);
      if (width === 300) {
        expect.soft(facts, context).toBeGreaterThan(0);
        await expect(parentRow.getByLabel("Child sessions needing you: 1"))
          .toBeVisible();
      }
      for (const id of ["R2", "R3", "R9"]) await inspect(page, id, context);
      if (scale !== "125") continue;
      if (width === 230) {
        const rank = (n: number) =>
          parentRow.locator(`[data-meta-rank="${n}"]`);
        if (await rank(3).count() && !await rank(3).isVisible()) {
          await expect(rank(6)).toBeHidden();
          await expect(rank(7)).toBeHidden();
        }
      }
      for (const [theme, label] of themes) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await childRow.hover();
        await inspect(page, "R1", `${context} hovered ${label}`);
        await inspect(page, "R2", `${context} ${label}`);
        await inspect(page, "R3", `${context} ${label}`);
        await capture(`sessions-${width}-${label}`);
      }
    }
  }
  await state.product("prefs.set", { key: "textSize", value: "125" });
  await expect(page.locator("html")).toHaveCSS("--otk-scale", "1.25");
  await page.locator('[data-panel-view="timeline"]').click();
  const timeline = page.locator(".otk-timeline-row");
  await expect(timeline).toHaveCount(1);
  await setRightWidth(300);
  await inspect(page, "R4", "base");
  await timeline.locator(".otk-timeline-reveal").click();
  await expect(timeline).toHaveClass(/is-selected/);
  for (const width of [300, 230]) {
    await setRightWidth(width);
    for (const [theme, label] of themes) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await timeline.hover();
      await inspect(page, "R4", `selected and hovered ${width} ${label}`);
      await capture(`timeline-${width}-${label}`);
    }
  }
  // D74: the composer and records are measured with the conversation exposed.
  await page.getByRole("button", { name: "Collapse right panel" }).click();
  await expect(page.locator(".otk-right-rail")).toBeVisible();
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [theme, label] of themes) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await inspect(page, "R7", `${width} ${label}`);
      await inspect(page, "R8", `${width} ${label}`);
      await capture(`composer-${width}-${label}`);
      await subagents(page).click();
      await expect(page.locator(".otk-subagent-row").first()).toBeVisible();
      await inspect(page, "R5", `${width} ${label}`);
      await capture(`subagents-${width}-${label}`);
      await page.keyboard.press("Escape");
    }
  }
  await restorePermissionDock(page);
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect.poll(async () =>
    JSON.stringify(await state.native(`/session/${child.id}/message`))
  ).toContain("The configuration is ready.");
  await page.locator(".otk-user-bubble").first().focus();
  await page.locator('.otk-messages [data-message-command="prompt.revert"]')
    .click();
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(page.locator(".otk-revert-group")).toHaveAttribute(
    "data-phase",
    "saved",
  );
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [theme, label] of themes) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await inspect(page, "R6", `${width} ${label}`);
      await capture(`record-${width}-${label}`);
    }
  }
});

test(
  "visual.header-title-end-truncation",
  { tag: ["@visual", "@isolated"] },
  async (
    { isolatedState: state, page },
    info,
  ) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await state.product("prefs.set", { key: "textSize", value: "125" });
    await state.product("layout.patch", { leftWidth: 248, rightWidth: 300 });
    const session = await seed(state, "Prepare facade rollout");
    await openSession(state, page, session.id);
    const current = page.locator(
      '.otk-trail [aria-current="page"] .otk-trail-title',
    );
    const tab = page.locator(
      '.otk-task-list [role="tab"][aria-selected="true"]',
    );
    await expect(current).toBeVisible();
    await expect(tab).toBeVisible();
    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 800 });
      for (const [theme, label] of themes) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        if (process.env.OTK_ROW_META_CAPTURE) {
          await page.screenshot({
            path: info.outputPath(`header-${width}-${label}.png`),
            animations: "disabled",
          });
        }
        await expect.soft(current).toHaveText("Prepare facade rollout");
        await expect.soft(current).toHaveCSS("text-overflow", "ellipsis");
        const frame = await tab.evaluate((el) => {
          const track = el.closest(".otk-task-list")!.getBoundingClientRect();
          const box = el.getBoundingClientRect();
          const title = el.querySelector(".otk-tab-title")!;
          const text = title.getBoundingClientRect();
          const sample = document.createElement("span");
          sample.style.cssText = "position:absolute;inline-size:max-content";
          sample.textContent = `${title.textContent?.trim().slice(0, 1)}…`;
          title.append(sample);
          const minimum = sample.getBoundingClientRect().width;
          sample.remove();
          const inner = getComputedStyle(
            el.querySelector(".otk-session-selection")!,
          );
          return {
            clipped: box.left < track.left - .5 || box.right > track.right + .5,
            inkRoom: text.width >= minimum,
            padded:
              box.right - text.right >= parseFloat(inner.paddingInlineEnd) - .5,
          };
        });
        expect.soft(frame, `selected tab frame at ${width}/${label}`).toEqual({
          clipped: false,
          inkRoom: true,
          padded: true,
        });
        await expect.soft(tab.locator(".otk-tab-title")).toHaveCSS(
          "text-overflow",
          "ellipsis",
        );
        await inspect(page, "R8", `reported header ${width}/${label}`);
      }
    }
  },
);
