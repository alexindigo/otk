// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { activity } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-hierarchy" });
const tags = { tag: ["@composer", "@sessions", "@contracts", "@isolated"] };
const main = "tstv1-otk";
const pillText = /^\s*1\s*2\s*3\s*$/;
const rowsInOrder = [2, 0, 1, 6, 4, 3].map((n) => `tstv1-disp-${n}`);
const longTitle =
  "Disposition helper 7 checking every checkout of the task for guest inventory drift before the merge queue runs";
const themes = [["otk-dark", "dark"], ["otk-light", "linen"], [
  "otk-light-stone",
  "stone",
]] as const;
const lineSelector = ".otk-composer-activity-line";
const dropdown =
  '.otk-popover-panel:popover-open:has([role="menu"][aria-label="Subagents"])';
const settings = async (state: Parameters<typeof openSession>[0]) => {
  await state.product("prefs.set", { key: "notify.toast", value: false });
  await state.product("prefs.set", { key: "textSize", value: "125" });
  await state.product("prefs.set", { key: "theme", value: "otk-dark" });
};

// Measure the same content box on the old tree, so the red probe fails on
// overflow rather than on a selector for the new region.
const lineBox = (page: Parameters<typeof openSession>[1]) =>
  page.locator(".otk-composer-activity").evaluate((row, selector) => {
    const line = row.querySelector(selector);
    const rect = (line ?? row).getBoundingClientRect();
    const css = getComputedStyle(row);
    const left = rect.left +
      (line
        ? 0
        : parseFloat(css.paddingLeft) + parseFloat(css.borderLeftWidth));
    const right = rect.right -
      (line
        ? 0
        : parseFloat(css.paddingRight) + parseFloat(css.borderRightWidth));
    return { left, right, width: right - left, top: rect.top };
  }, lineSelector);
const panelBox = (page: Parameters<typeof openSession>[1]) =>
  page.locator(dropdown).evaluate((node) => {
    const { left, right, width, bottom } = node.getBoundingClientRect();
    return { left, right, width, bottom };
  });

const openTask = async (
  state: Parameters<typeof openSession>[0],
  page: Parameters<typeof openSession>[1],
) => {
  const task = await state.product("tasks.create", {
    directory: state.directory,
    name: "One task across checkouts",
    sessions: [main],
  });
  for (const sessionID of [main, "tstv1-blocked"]) {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
      sessionID,
    });
  }
  await openSession(state, page, main);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
    target: "helper-dispositions",
  });
  return task;
};

test.describe("last subagent leaves the roster", () => {
  test.use({ profile: "contract-sessions-default" });
  const child = "tstv1-urgent-child";
  const startHelper = async (
    state: Parameters<typeof openSession>[0],
    page: Parameters<typeof openSession>[1],
  ) => {
    await state.product("prefs.set", { key: "notify.toast", value: false });
    await state.product("tasks.create", {
      directory: state.directory,
      name: "Review helper",
      sessions: [main],
    });
    await openSession(state, page, main);
    await activity(state, child, "hold");
  };

  test(
    "composer.subagents.open-list-empties-closes-to-header",
    tags,
    async ({ isolatedState: state, page }, info) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await startHelper(state, page);
      const pill = page.locator(".otk-subagents-trigger");
      const menu = page.getByRole("menu", { name: "Subagents", exact: true });
      const header = page.locator(".otk-composer-activity");
      const capture = async (phase: string) => {
        for (const [theme, label] of themes) {
          await state.product("prefs.set", { key: "theme", value: theme });
          await expect(page.locator("html")).toHaveAttribute(
            "data-otk-theme",
            theme,
          );
          await page.screenshot({
            path: info.outputPath(`activity-${phase}-${label}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
      };
      await expect(pill).toHaveAccessibleName("Subagents: 1 running");
      await capture("pill");
      await activity(state, child, "release");
      await expect(pill).toHaveAccessibleName("Subagents: 1 finished");
      await pill.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Clear finished" }))
        .toBeFocused();
      await page.keyboard.press("Tab");
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      await header.evaluate((region, panel) => {
        region.addEventListener("focus", () => {
          region.dataset.activityHandoff = JSON.stringify({
            open: !!document.querySelector(panel),
            mounted: !!region.querySelector(".otk-subagents-trigger"),
          });
        }, { once: true });
      }, dropdown);
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "release",
        sessionID: child,
        target: "trail-delivery",
      });
      await expect(menu).toHaveCount(0);
      await expect(pill).toHaveCount(0);
      await expect(header).toBeFocused();
      await expect(header).toHaveAttribute(
        "data-activity-handoff",
        '{"open":false,"mounted":true}',
      );
      await expect(header).toHaveCSS("outline-style", "none");
      await capture("header-focus");
      await expect(header).toBeFocused();

      await activity(state, child, "hold");
      await expect(pill).toHaveAccessibleName("Subagents: 1 running");
      await expect(pill).toHaveAttribute("aria-expanded", "false");
      await expect(menu).toHaveCount(0);
    },
  );

  test(
    "composer.subagents.clear-finished-closes-to-header",
    tags,
    async ({ isolatedState: state, page }) => {
      await startHelper(state, page);
      await expect(page.locator(".otk-subagents-trigger"))
        .toHaveAccessibleName("Subagents: 1 running");
      await activity(state, child, "release");
      const pill = page.locator(".otk-subagents-trigger");
      const menu = page.getByRole("menu", { name: "Subagents", exact: true });
      const clear = page.getByRole("button", { name: "Clear finished" });
      await expect(pill).toHaveAccessibleName("Subagents: 1 finished");
      await pill.focus();
      await page.keyboard.press("Enter");
      await expect(menu).toBeVisible();
      await expect(clear).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(menu).toHaveCount(0);
      await expect(pill).toHaveCount(0);
      await expect(page.locator(".otk-composer-activity")).toBeFocused();
    },
  );
});

test(
  "composer.subagents-pill-shows-per-state-counts",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const task = await openTask(state, page);
    const pill = page.getByRole("button", {
      name: "Subagents: 1 needs you, 2 running, 3 finished",
    });
    await expect(pill).toHaveText(pillText, { useInnerText: true });
    const tab = page.locator(`[data-tab="${task.id}"] .otk-status-light`);
    const lamp = pill.locator(".otk-status-light:visible");
    await expect(tab).toHaveAttribute("data-state", "blocked");
    await expect(lamp).toHaveCount(3);
    await expect(lamp.nth(0)).toHaveAttribute("data-state", "blocked");
    await expect(lamp.nth(1)).toHaveAttribute("data-state", "working");
    await expect(lamp.nth(2)).toHaveAttribute("data-state", "finished");
    const paint = (node: Element) => getComputedStyle(node).backgroundImage;
    expect(await lamp.first().evaluate(paint)).toEqual(
      await tab.evaluate(paint),
    );
  },
);

test(
  "composer.work-pills-pad-hover-and-keyboard-focus",
  tags,
  async ({ isolatedState: state, page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settings(state);
    await openTask(state, page);
    const pill = page.locator(".otk-subagents-trigger");
    await expect(pill).toBeVisible();
    const measure = () =>
      pill.evaluate((button) => {
        const border = button.getBoundingClientRect();
        // Zero-blur spread extends the painted button, not its layout box.
        const css = getComputedStyle(button);
        const spread = Number(css.boxShadow.match(/(-?[\d.]+)px$/)?.[1] ?? 0);
        const content = button.querySelector(".otk-live-count-compact")!;
        const lamp = content.querySelector(".otk-status-light")!
          .getBoundingClientRect();
        const label = Array.from(content.querySelectorAll(".otk-control-label"))
          .at(-1)!
          .getBoundingClientRect();
        const probe = document.createElement("span");
        probe.style.inlineSize = "var(--pill-work-inset, var(--space-2))";
        probe.style.blockSize = "var(--pill-block-inset, var(--space-1))";
        probe.style.position = "absolute";
        button.append(probe);
        const token = probe.getBoundingClientRect().width;
        const blockToken = probe.getBoundingClientRect().height;
        probe.remove();
        return {
          token,
          blockToken,
          left: lamp.left - border.left + spread,
          right: border.right - label.right + spread,
          top: Math.min(lamp.top, label.top) - border.top + spread,
          bottom: border.bottom - Math.max(lamp.bottom, label.bottom) + spread,
          end: label.right,
        };
      });
    const check = async (mode: string) => {
      const { token, blockToken, left, right, top, bottom, end } =
        await measure();
      expect(token).toBeGreaterThan(0);
      expect.soft(Math.min(left, right), `${mode}: inline padding`)
        .toBeGreaterThanOrEqual(token - .5);
      expect.soft(Math.abs(left - right), `${mode}: inline symmetry`)
        .toBeLessThanOrEqual(1);
      expect.soft(Math.min(top, bottom), `${mode}: block padding`)
        .toBeGreaterThanOrEqual(blockToken - .5);
      expect.soft(
        Math.abs(end - (await lineBox(page)).right),
        `${mode}: composer inset`,
      )
        .toBeLessThanOrEqual(.5);
    };
    await pill.hover();
    await check("hover");
    for (const [theme, label] of themes) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.screenshot({
        path: info.outputPath(`work-pill-hover-${label}.png`),
        fullPage: true,
      });
    }
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await pill.focus();
    await expect(pill).toBeFocused();
    await expect(pill).toHaveCSS("outline-style", "solid");
    await check("focus");
    await page.screenshot({
      path: info.outputPath("work-pill-focus-stone.png"),
      fullPage: true,
    });
  },
);

test(
  "composer.subagents-dropdown-groups-align-and-keep-titles",
  tags,
  async ({ isolatedState: state, page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settings(state);
    await openTask(state, page);
    // The supplied terminals are seconds old. Read these same clocks two
    // minutes later to exercise a numeric age and the fixed suffix slot.
    await page.clock.setFixedTime(new Date(Date.now() + 120_000));
    await page.locator(".otk-subagents-trigger").click();
    const menu = page.getByRole("menu", { name: "Subagents", exact: true });
    await expect(menu.locator(".otk-subagent-heading")).toHaveText([
      "Needs you 1",
      "Running 2",
      "Finished 3",
    ]);
    const rows = menu.locator("[data-subagent]");
    await expect(rows).toHaveCount(rowsInOrder.length);
    await expect.poll(() =>
      rows.evaluateAll((items) =>
        items.map((row) => row.getAttribute("data-subagent"))
      )
    ).toEqual(rowsInOrder);
    for (const [index, id] of rowsInOrder.entries()) {
      await expect(
        menu.locator(`[data-subagent="${id}"]`).getByRole("menuitem", {
          name: /^Terminate /,
        }),
      ).toHaveCount(index === 1 || index === 2 ? 1 : 0);
    }
    const time = (n: number) =>
      menu.locator(`[data-subagent="tstv1-disp-${n}"] .otk-subagent-time`);
    await expect(time(4)).toHaveText(/^2m ago$/);
    await expect(time(4).locator("time")).toHaveAttribute(
      "datetime",
      /^\d{4}-/,
    );
    await expect(time(3)).toHaveText(/^2m ago$/);
    await expect(time(3).locator("time")).toHaveAttribute(
      "datetime",
      /^\d{4}-/,
    );
    await expect(time(2)).toHaveAttribute("aria-label", "Waiting for you");
    await expect(time(2)).toHaveText(/^2m(?: \d+(?:\.\d)?s)?$/);
    await expect(time(2).locator("time")).toHaveAttribute("datetime", /^PT2M/);
    const facts: unknown[] = [];
    for (const [theme, label] of themes) {
      await expect(page.locator("html")).toHaveCSS("--otk-scale", "1.25");
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      const positions = await rows.evaluateAll((rows) =>
        rows.map((row) => {
          const title = row.querySelector<HTMLElement>(
            ".otk-subagent-name .otk-control-label",
          )!;
          const time = row.querySelector(".otk-subagent-time")!
            .getBoundingClientRect();
          const content = row.querySelector(".otk-subagent-time > *")!;
          const glyphs = document.createRange();
          glyphs.selectNodeContents(content);
          const textRight = glyphs.getBoundingClientRect().right;
          const cell = row.querySelector(".otk-subagent-terminate")!;
          const terminate = cell.querySelector("button");
          const svg = terminate?.querySelector("svg")?.getBoundingClientRect();
          const target = terminate?.getBoundingClientRect();
          const gaps = target && svg
            ? [
              svg.top - target.top,
              target.bottom - svg.bottom,
              svg.left - target.left,
              target.right - svg.right,
            ]
            : undefined;
          return {
            timeRight: time.right,
            textRight,
            terminateLeft: cell.getBoundingClientRect().left,
            gaps,
            title: title.getAttribute("title"),
            truncated: title.scrollWidth > title.clientWidth,
          };
        })
      );
      const line = await lineBox(page), panel = await panelBox(page);
      for (const [index, pos] of positions.entries()) {
        const context = `${label}/${rowsInOrder[index]}`;
        expect.soft(Math.abs(pos.timeRight - positions[0].timeRight), context)
          .toBeLessThanOrEqual(.5);
        expect.soft(
          Math.abs(pos.textRight - positions[0].textRight),
          `${context}: drawn time text`,
        )
          .toBeLessThanOrEqual(.5);
        expect.soft(
          Math.abs(pos.terminateLeft - positions[0].terminateLeft),
          context,
        )
          .toBeLessThanOrEqual(.5);
        if (pos.truncated) {
          expect.soft(Math.abs(panel.width - line.width), context)
            .toBeLessThanOrEqual(.5);
        }
        if (rowsInOrder[index] === "tstv1-disp-6") {
          expect.soft(pos.truncated, context).toBe(true);
        }
        expect.soft(pos.title, context).toBe(
          rowsInOrder[index] === "tstv1-disp-6"
            ? longTitle
            : `Disposition helper ${Number(rowsInOrder[index].at(-1)) + 1}`,
        );
        if (index === 1 || index === 2) {
          expect(pos.gaps, context).toBeDefined();
          expect.soft(Math.max(...pos.gaps!) - Math.min(...pos.gaps!), context)
            .toBeLessThanOrEqual(1);
        }
      }
      facts.push({ theme, positions });
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: info.outputPath(`subagents-dropdown-${label}.png`),
        fullPage: true,
        animations: "allow",
      });
    }
    await info.attach("subagents-geometry", {
      body: JSON.stringify(facts, null, 2),
      contentType: "application/json",
    });
  },
);

test(
  "composer.subagents-dropdown-stays-in-column",
  tags,
  async ({ isolatedState: state, page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settings(state);
    await openTask(state, page);
    await expect(page.locator("html")).toHaveCSS("--otk-scale", "1.25");
    const trigger = page.locator(".otk-subagents-trigger");
    const menu = page.getByRole("menu", { name: "Subagents", exact: true });
    const facts = [];
    for (const width of [1440, 1280, 1100, 960, 800]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 1440 || width === 1100) {
        await expect(page.locator('.otk-project-inbox[data-collapsed="false"]'))
          .toBeVisible();
        await expect(page.getByRole("tabpanel", { name: "Sessions" }))
          .toBeVisible();
      }
      await trigger.click();
      await expect(menu).toBeVisible();
      const line = await lineBox(page), panel = await panelBox(page);
      facts.push({ width, line, panel });
      expect.soft(panel.left, `${width}: left`).toBeGreaterThanOrEqual(
        line.left - .5,
      );
      expect.soft(panel.right, `${width}: right`).toBeLessThanOrEqual(
        line.right + .5,
      );
      expect.soft(Math.abs(panel.right - line.right), `${width}: flush`)
        .toBeLessThanOrEqual(.5);
      expect.soft(panel.bottom, `${width}: above`).toBeLessThanOrEqual(
        line.top + .5,
      );
      expect.soft(panel.width, `${width}: width`).toBeLessThanOrEqual(
        line.width + .5,
      );
      if (width === 960) {
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: info.outputPath("subagents-dropdown-narrow-dark.png"),
          fullPage: true,
        });
      }
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }
    // Retain the 800px two-sidebar geometry check above. Use the compact shell
    // for the three narrow screenshots, so there is room to read the agent.
    await state.product("layout.patch", { rightCollapsed: true });
    await expect(page.getByRole("tabpanel", { name: "Sessions" })).toBeHidden();
    await trigger.click();
    await expect(menu).toBeVisible();
    const line = await lineBox(page), panel = await panelBox(page);
    expect(panel.left).toBeGreaterThanOrEqual(line.left - .5);
    expect(Math.abs(panel.right - line.right)).toBeLessThanOrEqual(.5);
    for (const [theme, label] of themes) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: info.outputPath(`subagents-dropdown-800-${label}.png`),
        fullPage: true,
      });
    }
    await info.attach("bounds-geometry", {
      body: JSON.stringify(facts, null, 2),
      contentType: "application/json",
    });
    await expect(page.locator(lineSelector)).toBeVisible();
  },
);

test(
  "composer.subagents-dropdown-shows-each-agent",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settings(state);
    await openTask(state, page);
    await page.locator(".otk-subagents-trigger").click();
    const menu = page.getByRole("menu", { name: "Subagents", exact: true });
    const cell = (n: number) =>
      menu.locator(`[data-subagent="tstv1-disp-${n}"] .otk-subagent-agent`);
    const agents = [
      [0, "explore"],
      [1, "junior"],
      [2, "general"],
      [3, "explore"],
      [4, ""],
      [6, "junior-openrouter"],
    ] as const;
    await expect(menu.locator(".otk-subagent-agent")).toHaveCount(
      agents.length,
    );
    for (const [n, agent] of agents) {
      await expect(cell(n)).toHaveText(agent, { useInnerText: true });
    }
    const alignment = await menu.locator(".otk-subagent-agent").evaluateAll(
      (cells) =>
        cells.map((cell) => {
          const label = cell.querySelector<HTMLElement>(".otk-control-label");
          return {
            left: cell.getBoundingClientRect().left,
            lines: label
              ? label.getBoundingClientRect().height /
                parseFloat(getComputedStyle(label).lineHeight)
              : 1,
          };
        }),
    );
    for (const { left, lines } of alignment) {
      expect(Math.abs(left - alignment[0].left)).toBeLessThanOrEqual(.5);
      expect(lines).toBeCloseTo(1, 1);
    }
    await cell(0).getByRole("menuitem", { name: "explore details" }).hover();
    const preview = page.locator(
      '.otk-popover-panel:popover-open[aria-label="explore"]',
    );
    await expect(preview.locator("dt").first()).toHaveText("Agent");
    await expect(preview.locator("dd").first()).toHaveText("explore");
    const line = await lineBox(page);
    const rect = await preview.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(line.left - .5);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(line.right + .5);
  },
);
