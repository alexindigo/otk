// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { activity } from "../../pages/sessions.ts";
import { cleanup, viewport } from "../../pages/terminal.ts";

test.use({ profile: "contract-sessions-default" });
const tags = { tag: ["@composer", "@sessions", "@contracts", "@isolated"] };
const root = "tstv1-otk", child = "tstv1-urgent-child";
const themes = [
  ["otk-dark", "dark"],
  ["otk-light", "linen"],
  ["otk-light-stone", "stone"],
] as const;
const taskName = "otk#ark | main";
const longName =
  "Sticky selected task: review the destination before sending a message to the intended conversation";
const link = (page: Page) => page.locator(".otk-live-link");
const helpers = (page: Page) => page.locator(".otk-subagents-trigger");
const shells = (page: Page) => page.locator(".otk-live-work-trigger");
const animations = (page: Page) =>
  link(page).evaluate((el) =>
    el.getAnimations({ subtree: true }).map((animation) => ({
      name: (animation as CSSAnimation).animationName,
      state: animation.playState,
      props: [
        ...new Set(
          (animation.effect as KeyframeEffect).getKeyframes()
            .flatMap((frame) => Object.keys(frame))
            .filter((key) =>
              !["offset", "computedOffset", "easing", "composite"].includes(key)
            ),
        ),
      ],
    }))
  );
const activeAnimation = [{
  name: "otk-live-link-travel",
  state: "running",
  props: ["translate"],
}];

test(
  "composer.docked-terminal-leaves-the-header-with-its-input-and-room-for-history",
  tags,
  async ({ isolatedState: state, page }, info) => {
    test.setTimeout(120_000);
    await state.product("tasks.create", {
      directory: state.directory,
      name: "Facade rollout",
      sessions: [root],
    });
    await activity(state, child, "hold");
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
      target: "header-shells",
    });
    await openSession(state, page, root);
    await expect(helpers(page)).toHaveAccessibleName("Subagents: 1 running");
    await expect(shells(page)).toHaveAccessibleName("Running work: 2 shells");
    await page.getByRole("button", { name: "Open terminal", exact: true })
      .click();
    try {
      await expect(viewport(page)).toBeVisible();
      await expect(viewport(page)).not.toHaveAttribute(
        "aria-label",
        "Terminal output",
      );
      const target = page.locator(".otk-composer-target");
      const names = await target.locator(".otk-control-label")
        .allTextContents();
      expect(names).toHaveLength(2);
      await expect.soft(target).toHaveText(names.join(" · "));
      await expect.soft(target.locator("svg")).toHaveCount(0);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.mouse.move(0, 0);
      const facts = [];
      for (const [width, scale] of [[1440, 100], [1440, 125], [900, 125]]) {
        await page.setViewportSize({ width, height: 800 });
        await state.product("prefs.set", {
          key: "textSize",
          value: String(scale),
        });
        await expect(page.locator("html")).toHaveCSS(
          "--otk-scale",
          String(scale / 100),
        );
        for (const [theme, label] of themes) {
          await state.product("prefs.set", { key: "theme", value: theme });
          await expect(page.locator("html")).toHaveAttribute(
            "data-otk-theme",
            theme,
          );
          const geometry = await page.locator(".otk-session-view").evaluate(
            (pane) => {
              const box = (selector: string) =>
                pane.querySelector(selector)!
                  .getBoundingClientRect();
              const header = box(".otk-composer-activity-slot"),
                composer = box(".otk-composer"),
                terminal = box(".otk-composer-surface"),
                transcript = box(".otk-transcript-viewport");
              return {
                pane: box(".otk-session-content").height,
                transcript: transcript.height,
                terminal: terminal.height,
                terminalToHeader: header.top - terminal.bottom,
                headerToInput: composer.top - header.bottom,
                clippedSession: (() => {
                  const title = pane.querySelector(
                    ".otk-composer-destination",
                  )!;
                  return title.scrollWidth - title.clientWidth;
                })(),
                space: parseFloat(
                  getComputedStyle(
                    pane.querySelector(".otk-composer-activity")!,
                  ).paddingBlockEnd,
                ),
              };
            },
          );
          const context = `${width}/${scale}/${label}`;
          expect.soft(geometry.terminal, context).toBeGreaterThan(0);
          expect.soft(geometry.terminalToHeader, context)
            .toBeGreaterThanOrEqual(0);
          expect.soft(geometry.headerToInput, context).toBeGreaterThanOrEqual(
            0,
          );
          expect.soft(geometry.headerToInput, context).toBeLessThanOrEqual(
            geometry.space + 1,
          );
          expect.soft(geometry.transcript + .02, context)
            .toBeGreaterThanOrEqual(
              geometry.pane / 2,
            );
          expect.soft(geometry.clippedSession, context).toBeLessThanOrEqual(1);
          await expect.soft(helpers(page)).toHaveText("1");
          await expect.soft(helpers(page)).not.toHaveText(
            /running|needs you|returned/,
          );
          await expect.soft(shells(page)).toHaveText("2");
          facts.push({ width, scale, theme, ...geometry });
          await page.screenshot({
            path: info.outputPath(`wp7-${width}-${scale}-${label}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
      }
      await info.attach("wp7-geometry", {
        body: JSON.stringify(facts, null, 2),
        contentType: "application/json",
      });
    } finally {
      await cleanup(state, root);
    }
  },
);

test(
  "composer.running-shells-do-not-inherit-the-blocked-task-lamp",
  tags,
  async ({ isolatedState: state, page }) => {
    const task = await state.product("tasks.create", {
      directory: state.directory,
      name: taskName,
      sessions: [root],
    });
    await openSession(state, page, root);
    await activity(state, root, "freeze");
    const shellState = (action: "hold" | "release") =>
      state.controller.call("scenario", {
        lease: state.lease.lease,
        action,
        target: "header-shells",
      });
    await shellState("hold");
    const tabLamp = page.locator(`[data-tab="${task.id}"] .otk-status-light`);
    await expect(tabLamp).toHaveAttribute("data-state", "blocked");
    const pill = shells(page);
    await expect(pill).toHaveAccessibleName("Running work: 2 shells");
    await expect(pill.locator(".otk-status-light"))
      .toHaveAttribute("data-state", "working");
    await pill.click();
    const list = page.getByRole("list", { name: "Running shells" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list).toContainText("sleep 120");
    await shellState("release");
    await expect(pill).toHaveCount(0);
    await expect(tabLamp).toHaveAttribute("data-state", "blocked");
  },
);

test(
  "composer.header-link-moves-for-own-run-without-helpers-or-shells",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openSession(state, page, root);
    await expect(helpers(page)).toHaveCount(0);
    await expect(shells(page)).toHaveCount(0);
    await expect(link(page)).toHaveCount(0);

    await activity(state, root, "hold");
    await expect(page.locator(`[data-crumb="${root}"] .otk-status-light`))
      .toHaveAttribute("data-state", "working");
    await expect(helpers(page)).toHaveCount(0);
    await expect(shells(page)).toHaveCount(0);
    await expect(link(page)).toHaveAttribute("data-state", "running");
    await expect.poll(() => animations(page)).toEqual(activeAnimation);

    await activity(state, root, "release");
    await expect(link(page)).toHaveCount(0);
  },
);

test(
  "composer.finished-helper-does-not-inherit-the-running-main-lamp",
  tags,
  async ({ isolatedState: state, page }) => {
    const task = await state.product("tasks.create", {
      directory: state.directory,
      name: taskName,
      sessions: [root],
    });
    await openSession(state, page, root);
    await activity(state, root, "hold");
    await activity(state, child, "hold");
    await activity(state, child, "release");
    const pill = helpers(page),
      lamp = pill.locator(".otk-status-light:visible");
    await expect(pill).toHaveAccessibleName("Subagents: 1 finished");
    await expect(page.locator(`[data-tab="${task.id}"] .otk-status-light`))
      .toHaveAttribute("data-state", "working");
    await expect.soft(lamp).toHaveAttribute(
      "data-state",
      /^(?:none|finished)$/,
    );
    // 2.104: the main's own run animates the connector without changing
    // the helper pill's independent verdict.
    await expect.soft(link(page)).toHaveAttribute("data-state", "running");
    await expect.poll(() => animations(page)).toEqual(activeAnimation);
  },
);

test(
  "composer.header-row-gaps-and-centerline-borrow-tokens-in-all-themes",
  tags,
  async ({ isolatedState: state, page }, info) => {
    test.setTimeout(240_000);
    const task = await state.product("tasks.create", {
      directory: state.directory,
      name: taskName,
      sessions: [root],
    });
    await activity(state, child, "hold");
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
      target: "header-shells",
    });
    await openSession(state, page, root);
    await expect(helpers(page)).toHaveAccessibleName("Subagents: 1 running");
    await expect(shells(page)).toHaveAccessibleName("Running work: 2 shells");
    await expect(link(page)).toHaveAttribute("data-state", "running");
    const facts: unknown[] = [];
    const check = async (
      width: number,
      scale: number,
      theme: string,
      stage = "full",
    ) => {
      const measured = await page.locator(".otk-composer-dock").evaluate(
        (dock) => {
          const at = (selector: string) =>
            dock.querySelector<HTMLElement>(selector)!;
          const box = (selector: string) =>
            at(selector).getBoundingClientRect();
          const row = at(".otk-composer-activity");
          const center = (box: DOMRect) => (box.top + box.bottom) / 2;
          const rowCenter = center(row.getBoundingClientRect()) -
            parseFloat(getComputedStyle(row).paddingBlockEnd) / 2;
          const title = box(".otk-composer-target"),
            connector = box(".otk-live-link");
          const pills = [".otk-subagents-trigger", ".otk-live-work-trigger"];
          const count = (pill: string) => `${pill} .otk-live-count`;
          const lastPill = box(pills[1]);
          const wrapped = lastPill.top >= title.bottom;
          const probe = document.createElement("span");
          probe.style.cssText =
            "position:absolute;inline-size:var(--row-title-min)";
          at(".otk-composer-task").append(probe);
          const floor = probe.getBoundingClientRect().width;
          probe.remove();
          const titleMinimum = connector.width ? floor : Math.min(
            floor,
            title.width - box(".otk-composer-destination").width -
              box(".otk-composer-separator").width,
          );
          return {
            leading: title.left - box(".otk-prompt-input").left,
            trailing: lastPill.right -
              (wrapped
                ? row.getBoundingClientRect().right -
                  parseFloat(getComputedStyle(row).paddingInlineEnd) -
                  parseFloat(getComputedStyle(row).borderInlineEndWidth)
                : box(".otk-send-button").right),
            titleToLink: connector.left - title.right,
            linkToPill: box(pills[0]).left - connector.right,
            betweenPills: box(pills[1]).left - box(pills[0]).right,
            pillText: pills.map((pill) => at(pill).innerText),
            titleWidth: box(".otk-composer-task").width,
            titleMinimum,
            wrap: wrapped,
            linkOnPillLine: !connector.width ||
              Math.abs(center(connector) - center(lastPill)) <= .5,
            overflow: row.scrollWidth - row.clientWidth,
            lampGaps: pills.map((pill) =>
              box(`${count(pill)} .otk-chrome-meta`).left -
              box(`${count(pill)} .otk-status-light`).right
            ),
            centerDrifts: [
              ...(connector.width ? [".otk-live-link"] : []),
              ".otk-composer-task",
              ...pills.flatMap((pill) => [
                `${count(pill)} .otk-status-light`,
                `${count(pill)} .otk-chrome-meta`,
              ]),
            ].map((selector) =>
              center(box(selector)) -
              (wrapped
                ? selector === ".otk-composer-task"
                  ? center(title)
                  : center(lastPill)
                : rowCenter)
            ),
            linkWidth: connector.width,
            truncated: [
              ...pills.map((pill) => `${count(pill)} .otk-chrome-meta`),
              ".otk-composer-task",
            ].map((selector) => {
              const label = at(selector);
              return label.scrollWidth > label.clientWidth;
            }),
          };
        },
      );
      const u = scale / 100, context = `${width}/${scale}/${theme}`;
      for (
        const [axis, delta, limit] of [
          ["leading inset", measured.leading, 1],
          ["trailing inset", measured.trailing, 1],
          ...(measured.linkWidth
            ? [
              ...(measured.wrap ? [] : [[
                "title to link",
                measured.titleToLink - 12 * u,
                .5,
              ]] as const),
              [
                "link to pill",
                measured.linkToPill - 12 * u,
                .5,
              ],
            ] as const
            : []),
          ["between pills", measured.betweenPills - 16 * u, .5],
          [
            "lamp gap equality",
            measured.lampGaps[0] - measured.lampGaps[1],
            .5,
          ],
          ...measured.lampGaps.map((gap, i) =>
            [`lamp ${i}`, gap - 8 * u, .5] as const
          ),
          ...measured.centerDrifts.map((drift, i) =>
            [`center ${i}`, drift, .5] as const
          ),
        ] as const
      ) {
        expect.soft(Math.abs(delta), `${context}: ${axis}`)
          .toBeLessThanOrEqual(limit);
      }
      if (stage === "full" || stage === "wrap-with-link") {
        expect.soft(measured.linkWidth, context).toBeGreaterThanOrEqual(
          24 * u - .5,
        );
      } else expect.soft(measured.linkWidth, context).toBe(0);
      expect.soft(measured.pillText, context).toEqual(["1", "2"]);
      expect.soft(measured.wrap, context).toBe(stage !== "full");
      expect.soft(measured.linkOnPillLine, context).toBe(true);
      expect.soft(measured.overflow, context).toBeLessThanOrEqual(1);
      expect.soft(measured.truncated, context).toEqual([
        false,
        false,
        width < 1000 && stage !== "full",
      ]);
      if (stage !== "full") {
        expect.soft(measured.titleMinimum, context).toBeGreaterThan(0);
        expect.soft(measured.titleWidth, context).toBeGreaterThanOrEqual(
          measured.titleMinimum - .5,
        );
        await expect(helpers(page)).toHaveAttribute(
          "title",
          "Subagents: 1 running",
        );
        await expect(shells(page)).toHaveAttribute(
          "title",
          "Running work: 2 shells",
        );
      }
      facts.push({ width, scale, theme, ...measured });
    };
    const shot = async (name: string) => {
      await link(page).evaluate((el) => {
        const [light] = el.getAnimations({ subtree: true });
        if (light) {
          light.pause();
          light.currentTime = 1170;
        }
      });
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: info.outputPath(name),
        fullPage: true,
        animations: "allow",
      });
    };
    for (const width of [1440, 760]) {
      await page.setViewportSize({ width, height: 900 });
      await state.product("layout.patch", {
        leftCollapsed: width === 760,
        rightCollapsed: width === 760,
      });
      await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
        "data-collapsed",
        String(width === 760),
      );
      for (const scale of [100, 125]) {
        await state.product("prefs.set", {
          key: "textSize",
          value: String(scale),
        });
        await expect(page.locator("html")).toHaveCSS(
          "--otk-scale",
          String(scale / 100),
        );
        for (const [theme, label] of themes) {
          await state.product("prefs.set", { key: "theme", value: theme });
          await expect(page.locator("html")).toHaveAttribute(
            "data-otk-theme",
            theme,
          );
          await check(width, scale, label);
          if (width === 1440 && scale === 125) {
            await shot(
              `header-row-running-${label}.png`,
            );
          }
        }
      }
    }
    await page.setViewportSize({ width: 800, height: 800 });
    await state.product("prefs.set", { key: "theme", value: "otk-dark" });
    await state.product("layout.patch", {
      leftCollapsed: false,
      rightCollapsed: false,
      leftWidth: 200,
      rightWidth: 280,
    });
    await state.product("tasks.rename", {
      id: task.id,
      name: longName,
    });
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-otk-theme",
      "otk-dark",
    );
    await expect(page.locator(".otk-composer-task")).toHaveText(longName);
    await expect(page.locator(".otk-project-inbox")).toHaveCSS(
      "width",
      "200px",
    );
    for (const [theme, label] of themes) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await check(800, 125, label, "wrap-with-link");
      await shot(`header-row-narrow-${label}.png`);
    }
    await page.setViewportSize({ width: 775, height: 900 });
    await check(775, 125, "stone", "wrap");
    await state.product("layout.patch", {
      leftCollapsed: true,
      rightWidth: 300,
    });
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await page.setViewportSize({ width: 600, height: 900 });
    await check(600, 125, "stone", "wrap");
    await info.attach("header-geometry", {
      body: JSON.stringify(facts, null, 2),
      contentType: "application/json",
    });
  },
);

test(
  "composer.header-link-moves-only-while-work-runs",
  tags,
  async ({ isolatedState: state, page }) => {
    await activity(state, child, "hold");
    await openSession(state, page, root);
    const shellState = (action: "hold" | "release") =>
      state.controller.call("scenario", {
        lease: state.lease.lease,
        action,
        target: "header-shells",
      });
    const expectRunning = async () => {
      await expect(link(page)).toHaveAttribute("data-state", "running");
      await expect.poll(() => animations(page)).toEqual(activeAnimation);
    };
    await expect(shells(page)).toHaveCount(0);
    await expectRunning();
    await shellState("hold");
    await expect(shells(page)).toHaveAccessibleName("Running work: 2 shells");
    await activity(state, child, "release");
    await expect(helpers(page)).toHaveAccessibleName(
      "Subagents: 1 finished",
    );
    await expectRunning();
    await shellState("release");
    await expect(link(page)).toHaveAttribute("data-state", "idle");
    await expect.poll(() => animations(page)).toEqual([]);
    await expect(link(page).locator(".otk-live-link-light")).toHaveCSS(
      "visibility",
      "hidden",
    );
    await expect(helpers(page)).toHaveAccessibleName(
      "Subagents: 1 finished",
    );
    await activity(state, child, "hold");
    await expect(helpers(page)).toHaveAccessibleName("Subagents: 1 running");
    await expectRunning();
    await activity(state, child, "release");
    await expect(link(page)).toHaveAttribute("data-state", "idle");
    const boxes = () =>
      page.locator(".otk-composer-activity").evaluate((row) =>
        [row, row.querySelector(".otk-composer-target")!].flatMap((el) => {
          const { top, left, height } = el.getBoundingClientRect();
          return [top, left, height];
        })
      );
    const before = await boxes();
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
      sessionID: child,
      target: "trail-delivery",
    });
    await expect(link(page)).toHaveCount(0);
    await expect(helpers(page)).toHaveCount(0);
    await expect(shells(page)).toHaveCount(0);
    for (const [index, value] of (await boxes()).entries()) {
      expect(
        Math.abs(value - before[index]),
        `box ${index}: ${before[index]} -> ${value}`,
      ).toBeLessThanOrEqual(.5);
    }
  },
);

test(
  "composer.header-link-is-still-under-reduced-motion",
  tags,
  async ({ isolatedState: state, page }, info) => {
    await state.product("tasks.create", {
      directory: state.directory,
      name: taskName,
      sessions: [root],
    });
    await activity(state, child, "hold");
    await openSession(state, page, root);
    await page.setViewportSize({ width: 1440, height: 900 });
    await state.product("prefs.set", { key: "textSize", value: "125" });
    await expect(page.locator("html")).toHaveCSS("--otk-scale", "1.25");
    const check = async (running: boolean) => {
      await expect(link(page)).toHaveAttribute(
        "data-state",
        running ? "running" : "idle",
      );
      await expect.poll(() => animations(page)).toEqual([]);
      await expect(link(page).locator(".otk-live-link-light")).toHaveCSS(
        "visibility",
        "hidden",
      );
      const color = await link(page).evaluate((el, running) => {
        const probe = document.createElement("span");
        probe.style.background = running
          ? "color-mix(in srgb, var(--status-light-working) 80%, transparent)"
          : "color-mix(in srgb, var(--otk-fg-3) 45%, transparent)";
        el.append(probe);
        const background = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return background;
      }, running);
      await expect(link(page)).toHaveCSS("background-color", color);
    };
    await page.emulateMedia({ reducedMotion: "reduce" });
    await check(true);
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
      target: "header-shells",
    });
    await expect(shells(page)).toHaveAccessibleName("Running work: 2 shells");
    for (const [theme, label] of themes) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await check(true);
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: info.outputPath(`header-row-reduced-${label}.png`),
        fullPage: true,
        animations: "allow",
      });
    }
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
      target: "header-shells",
    });
    await activity(state, child, "release");
    await check(false);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await state.product("prefs.set", { key: "animationsOff", value: true });
    await expect(page.locator("html")).toHaveAttribute(
      "data-otk-animations-off",
      "",
    );
    await activity(state, child, "hold");
    await check(true);
    await activity(state, child, "release");
    await check(false);
    await state.product("prefs.set", { key: "animationsOff", value: false });
  },
);
