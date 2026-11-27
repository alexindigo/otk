// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator, Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";
import { restorePermissionDock } from "../../pages/crumbs.ts";

const rail = (page: Page, side: "left" | "right") =>
  page.locator(`.otk-sidebar-rail[data-side="${side}"]`);

async function inspect(list: Locator) {
  return await list.evaluate(async (list) => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    const issues: string[] = [];
    const box = (element: Element) => element.getBoundingClientRect();
    const shown = (el: Element) =>
      getComputedStyle(el).visibility === "visible";
    const measure = (el: Element, value: string, axis = "inline") => {
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;${axis}-size:${value}`;
      el.append(probe);
      const width = axis === "inline" ? box(probe).width : box(probe).height;
      probe.remove();
      return width;
    };
    const rects = (el: Element) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const boxes: DOMRect[] = [];
      while (walker.nextNode()) {
        range.selectNodeContents(walker.currentNode);
        boxes.push(
          ...Array.from(range.getClientRects()).filter((r) => r.width),
        );
      }
      return boxes;
    };
    const near = (a: number, b: number) => Math.abs(a - b) <= .5;
    const entries = Array.from(
      list.querySelectorAll<HTMLElement>(
        ".otk-sidebar-frame, .otk-section-header:has(.otk-sidebar-row)",
      ),
    )
      .flatMap((frame) => {
        const node = frame.closest<HTMLElement>(".otk-tree-node");
        const label = frame.querySelector<HTMLElement>("[data-row-title]");
        if (!node || !label || !box(frame).height) return [];
        return [{ frame, node, label, depth: Number(node.dataset.depth ?? 0) }];
      });
    const axis = new Map<number, number[]>();
    let hidden = 0;
    let facts = 0;
    let avatars = 0;
    let stems = 0;
    let through = 0;
    for (const [i, { frame, node, label, depth }] of entries.entries()) {
      const q = (selector: string) =>
        frame.querySelector<HTMLElement>(selector)!;
      const own = (selector: string) =>
        node.querySelector<HTMLElement>(
          `:scope > .otk-tree-heading ${selector}`,
        );
      const row = box(frame);
      const height = measure(frame, "var(--row-project)", "block");
      const space = measure(frame, "var(--space-2)");
      const name = label.textContent?.trim();
      const check = (ok: boolean, description: string) => {
        if (!ok) issues.push(`${name}: ${description}`);
      };
      const feedback = q(".otk-sidebar-row-feedback");
      const hasFeedback = feedback && box(feedback).height > 0;
      const next = entries[i + 1];
      check(!!node.dataset.depth, "flat tree path missing");
      if (!hasFeedback) {
        check(
          near(row.height, height),
          `row height ${row.height} vs ${height}`,
        );
        if (
          next && box(next.frame).top > row.top &&
          !frame.closest(".otk-virtual-sample") &&
          (list.dataset.side === "right" ||
            node.parentElement === next.node.parentElement)
        ) {
          check(near(box(next.frame).top - row.top, height), "row pitch");
        }
      }
      const lamp = box(q(".otk-sidebar-lamp"));
      const art = box(q(".otk-sidebar-icon"));
      const title = box(label);
      const columns = [lamp.left, art.left, title.left];
      const prior = axis.get(depth);
      if (prior) {
        check(columns.every((x, j) => near(x, prior[j])), "label/slot axis");
      } else axis.set(depth, columns);
      const avatar = q(".otk-project-avatar");
      if (avatar) {
        avatars++;
        check(title.left - box(avatar).right >= space - .5, "avatar padding");
      }
      const titleRects = rects(label);
      const inLine = (r: DOMRect) =>
        r.top >= row.top - .5 && r.bottom <= row.top + height + .5;
      // Title qualifiers and status controls can have a different font size;
      // check each run against the line track, and each item against itself.
      check(
        getComputedStyle(label).whiteSpace === "nowrap" &&
          titleRects.every(inLine),
        "title out of line",
      );
      const items = Array.from(
        frame.querySelectorAll<HTMLElement>(".otk-meta-item"),
      );
      hidden += items.filter((item) => item.hidden).length;
      const visible = items.filter((item) =>
        !item.hidden && shown(item) && box(item).width > 0
      );
      const control = q(".otk-sidebar-control");
      if (control && Number(getComputedStyle(control).opacity) > 0) {
        check(!visible.length, "hover control and metadata both painted");
        check(
          row.right - box(control).right >= space - .5,
          "control edge padding",
        );
      }
      facts += visible.length;
      if (visible.length) {
        const range = document.createRange();
        range.selectNodeContents(label);
        const intrinsic = range.getBoundingClientRect().width;
        const floor = Math.min(
          measure(label, "var(--row-title-min)"),
          intrinsic,
        );
        check(
          title.width >= floor - 1,
          `title floor ${title.width} vs ${floor}`,
        );
      }
      for (const item of visible) {
        const text = rects(item);
        check(
          text.every((r) => inLine(r) && near(r.top, text[0].top)),
          "meta wrapped or out of line",
        );
        check(item.scrollWidth <= item.clientWidth + .5, "meta clipped");
        check(row.right - box(item).right >= space - .5, "meta edge padding");
      }
      const stem = q(".otk-tree-icon.has-stem .otk-tree-icon-stem");
      if (!next) continue;
      const nextOwn = (selector: string) =>
        next.node.querySelector<HTMLElement>(
          `:scope > .otk-tree-heading ${selector}`,
        );
      if (stem && shown(stem)) {
        stems++;
        const incoming = nextOwn(".otk-tree-incoming .otk-tree-upper");
        const extension = q(".otk-tree-icon-extension");
        const tail = extension && box(extension).height ? extension : stem;
        check(
          !!incoming && near(box(incoming).left, box(tail).left) &&
            near(box(incoming).top, box(tail).bottom),
          "stem to child elbow continuity",
        );
      }
      for (
        const lower of Array.from(node.querySelectorAll(
          ":scope > .otk-tree-heading :is(.otk-tree-rails, .otk-tree-own) .is-through .otk-tree-lower, :scope > .otk-tree-heading .otk-tree-own.is-through .otk-tree-lower",
        ))
      ) {
        const painted = (el: Element) =>
          shown(el) && getComputedStyle(el).backgroundImage !== "none";
        const lanes = Array.from(
          next.node.querySelectorAll(
            ":scope > .otk-tree-heading :is(.otk-tree-rails, .otk-tree-own) .otk-tree-upper",
          ),
        ).filter(painted);
        if (!painted(lower)) continue;
        const endpoint = own(".otk-tree-extension");
        if (!endpoint) continue;
        through++;
        check(
          lanes.some((upper) =>
            near(box(upper).left, box(lower).left) &&
            near(box(upper).top, row.bottom)
          ),
          "through lane continuity",
        );
      }
    }
    const indent = measure(list, "var(--tree-indent)");
    for (const [depth, columns] of axis) {
      const parent = axis.get(depth - 1);
      if (parent && !near(columns[2] - parent[2], indent)) {
        issues.push(`depth ${depth}: title step`);
      }
    }
    return {
      issues,
      hidden,
      facts,
      avatars,
      stems,
      through,
      rows: entries.length,
    };
  });
}

async function layout(state: TestState) {
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await state.product("layout.patch", {
    leftWidth: 200,
    leftCollapsed: false,
    rightWidth: 280,
    rightCollapsed: false,
    rightView: "sessions",
  });
}

async function matrix(state: TestState, page: Page, side: "left" | "right") {
  const list = rail(page, side);
  const widths = side === "left" ? [200, 248] : [280, 320];
  for (const root of [13, 20]) {
    const rule = await page.addStyleTag({
      content: `:root{font-size:${root}px}`,
    });
    for (const text of ["100", "125"]) {
      await state.product("prefs.set", { key: "textSize", value: text });
      await expect(page.locator("html")).toHaveCSS(
        "--otk-scale",
        String(+text / 100),
      );
      let narrow = 0;
      for (const width of widths) {
        await state.product(
          "layout.patch",
          side === "left" ? { leftWidth: width } : { rightWidth: width },
        );
        await expect(list).toHaveCSS("width", `${width}px`);
        const report = await inspect(list);
        const id = `${side} root ${root}, text ${text}, width ${width}`;
        expect.soft(report.issues, id).toEqual([]);
        expect.soft(report.rows, `${id}: populated fixture`).toBeGreaterThan(2);
        expect.soft(report.stems, `${id}: open parent`).toBeGreaterThan(0);
        if (side === "left") {
          expect.soft(report.avatars, `${id}: project art`).toBeGreaterThan(0);
        }
        if (width === widths[0]) narrow = report.hidden;
        else {
          expect.soft(report.hidden, `${id}: fact recovery`)
            .toBeLessThanOrEqual(narrow);
          expect.soft(report.facts, `${id}: visible facts`).toBeGreaterThan(0);
        }
      }
    }
    await rule.evaluate((element) => element.parentNode?.removeChild(element));
  }
}

for (const zoom of [1, 1.25, 1.5, 1.75, 2]) {
  test.describe(`${zoom * 100}%`, () => {
    test.use({
      viewport: {
        width: Math.round(1684 / zoom),
        height: Math.round(1300 / zoom),
      },
      deviceScaleFactor: zoom,
    });
    test.describe("projects", () => {
      test.use({ profile: "contract-sessions-sidebar" });
      test(`visual.sidebar-zoom.${zoom * 100}.projects`, {
        tag: ["@visual", "@isolated"],
      }, async ({ isolatedState: state, page }) => {
        await layout(state);
        await page.clock.setFixedTime(Date.now() + 58 * 3_600_000);
        await openSession(state, page, "tstv1-sidebar-all-required-0");
        const { root } = await state.observe<{ root: string }>();
        const project = (name: string) =>
          page.locator(
            `.otk-project-row[data-project=${
              JSON.stringify(`${root}/sidebar/${name}`)
            }]`,
          );
        const parent = project("all-required");
        await expect(parent).toBeVisible();
        const child = project("all-required-child-0");
        if (!await child.isVisible()) {
          await parent.locator(
            "xpath=ancestor::div[contains(@class,'otk-tree-heading')][1]",
          ).locator(".otk-tree-toggle").click();
        }
        await expect(child).toBeVisible();
        await page.mouse.move(0, 0);
        await matrix(state, page, "left");
        await parent.locator(".otk-sidebar-label").hover();
        await expect.soft(parent.locator(".otk-sidebar-control")).toHaveCSS(
          "opacity",
          "1",
          { timeout: 1000 },
        );
        expect.soft(
          (await inspect(rail(page, "left"))).issues,
          "hovered project geometry",
        ).toEqual([]);
      });
    });
    test.describe("sessions", () => {
      test.use({ profile: "isolated" });
      test(`visual.sidebar-zoom.${zoom * 100}.sessions`, {
        tag: ["@visual", "@isolated"],
      }, async ({ isolatedState: state, page }) => {
        await layout(state);
        const parent = await seed(state, "Execution and dependency review");
        const child = await seed(
          state,
          "Validate the release configuration",
          parent.id,
        );
        await seed(
          state,
          "Review the reporting and evaluation contracts",
          parent.id,
        );
        await seed(
          state,
          "Summarize the browser verification evidence",
          parent.id,
        );
        await seed(
          state,
          "Confirm the transitive dependency inventory",
          child.id,
        );
        await openSession(state, page, parent.id);
        await tool(state, "bash", {
          command: "printf review-dependencies",
          description: "Review dependencies",
        });
        await state.queue(["The configuration is ready."]);
        await state.native(`/session/${child.id}/prompt_async`, "POST", {
          parts: [{ type: "text", text: "Validate the release configuration" }],
        });
        const row = (id: string) =>
          rail(page, "right").locator(`.otk-session-row[data-session="${id}"]`);
        await expect(row(parent.id)).toHaveClass(/is-selected/);
        await expect(row(child.id)).toContainText("P 1");
        await page.locator(".otk-permission-dock").getByRole("button", {
          name: "Dismiss locally",
        }).click();
        await page.mouse.move(0, 0);
        await matrix(state, page, "right");
        await restorePermissionDock(page);
        await page.getByRole("button", { name: "Allow once", exact: true })
          .click();
        await expect.poll(async () =>
          JSON.stringify(await state.native(`/session/${child.id}/message`))
        ).toContain("The configuration is ready.");
      });
    });
  });
}
