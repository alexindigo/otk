// SPDX-License-Identifier: LGPL-3.0-only
import type { Page, TestInfo } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { auditUiRules } from "../../pages/ui-rules.ts";

const themes = ["otk-dark", "otk-light", "otk-light-stone"] as const;
const tags = { tag: ["@visual", "@sessions", "@contracts"] };

async function settle(page: Page) {
  await page.evaluate(() =>
    document.fonts.ready.then(() =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    )
  );
}
async function paint(
  state: TestState,
  page: Page,
  theme: typeof themes[number],
) {
  await state.product("prefs.set", { key: "theme", value: theme });
  await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
  await settle(page);
}
async function record(info: TestInfo, name: string, value: unknown) {
  await info.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: "application/json",
  });
}
async function shot(page: Page, info: TestInfo, name: string) {
  await settle(page);
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

/** Measure the actual consumer, including the indicator track, not a guessed inset. */
async function lamps(page: Page) {
  return await page.locator(".otk-tab-open:visible,.otk-session-crumb:visible")
    .evaluateAll((controls) =>
      controls.map((control) => {
        const c = control.getBoundingClientRect(),
          icon = control.querySelector(".otk-status-light")!,
          r = icon.getBoundingClientRect();
        const slot = icon.parentElement!,
          s = slot.getBoundingClientRect(),
          css = getComputedStyle(slot);
        return {
          id: control.getAttribute("data-tab") ??
            control.getAttribute("data-crumb"),
          gaps: [r.left - c.left, r.top - c.top, c.bottom - r.bottom],
          controlHeight: c.height,
          slot: [s.width, s.height],
          position: css.position,
          transform: css.transform,
          selected: control.classList.contains("is-selected"),
        };
      })
    );
}

/** Common rendered contracts for every shell region and mounted state. */
async function audit(page: Page, info: TestInfo, state: string) {
  await auditUiRules(page, info, state);
}

test.describe("panel content column", () => {
  test.use({ profile: "contract-visual-inbox" });
  test(
    "visual.ui-rules-panel-empty-and-normal-column",
    tags,
    async ({ isolatedState: state, page }, info) => {
      await state.product("layout.patch", {
        rightCollapsed: false,
        rightView: "sessions",
      });
      await page.goto(state.url);
      await expect(page.getByText("Choose a project to browse its sessions."))
        .toBeVisible();
      for (const theme of themes) {
        await paint(state, page, theme);
        const geometry = await page.locator(".otk-panel-content").evaluate(
          (el) => {
            const p = el.querySelector("p")!.getBoundingClientRect(),
              h = el.querySelector("h2")!.getBoundingClientRect(),
              r = el.closest(".otk-right-panel")!.getBoundingClientRect();
            return {
              heading: h.left,
              empty: p.left,
              panel: r.left,
              delta: Math.abs(h.left - p.left),
            };
          },
        );
        await record(info, "panel-empty-" + theme, geometry);
        await shot(page, info, "panel-empty-" + theme);
        expect.soft(geometry.delta).toBeLessThanOrEqual(1);
        expect.soft(geometry.empty - geometry.panel).toBeGreaterThan(0);
        await audit(page, info, "empty-" + theme);
      }
      await page.locator('[data-panel-view="timeline"]').click();
      await expect(page.getByText("Open a session to see its prompts."))
        .toBeVisible();
      for (const theme of themes) {
        await paint(state, page, theme);
        const g = await page.locator(".otk-panel-content").evaluate((el) => {
          const heading = el.querySelector("h2")!.getBoundingClientRect(),
            empty = el.querySelector(".otk-empty")!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(el.querySelector(".otk-empty")!);
          return {
            heading: heading.left,
            empty: empty.left,
            text: range.getBoundingClientRect().left,
          };
        });
        await record(info, "timeline-empty-" + theme, g);
        await shot(page, info, "timeline-empty-" + theme);
        expect.soft(
          Math.max(g.heading, g.empty, g.text) -
            Math.min(g.heading, g.empty, g.text),
        ).toBeLessThanOrEqual(1);
      }
      await openSession(state, page, "tstv1-otk");
      await page.locator("input[type=search]").fill(
        "no matching UI audit session",
      );
      await expect(page.getByText("No matching sessions", { exact: true }))
        .toBeVisible();
      for (const theme of themes) {
        await paint(state, page, theme);
        const g = await page.locator(".otk-panel-content").evaluate((el) => {
          const left = (selector: string) =>
            el.querySelector(selector)!.getBoundingClientRect().left;
          return {
            heading: left("h2"),
            empty: left(".otk-project-session-content p"),
            toolbar: left(".otk-project-session-heading"),
          };
        });
        await record(info, "panel-filter-empty-" + theme, g);
        expect.soft(
          Math.max(g.heading, g.empty, g.toolbar) -
            Math.min(g.heading, g.empty, g.toolbar),
        ).toBeLessThanOrEqual(1);
      }
    },
  );
});

test.describe("loading content column", () => {
  test.use({ profile: "contract-sessions-progress" });
  test(
    "visual.ui-rules-panel-loading-status-and-ready-column",
    tags,
    async ({ isolatedState: state, page }, info) => {
      await state.product("layout.patch", {
        rightCollapsed: false,
        rightView: "sessions",
      });
      await page.goto(state.url + "/#/local/tstv1-core");
      await expect(page.locator(".otk-session-loading-row")).toBeVisible();
      for (const theme of themes) {
        await paint(state, page, theme);
        const g = await page.locator(".otk-panel-content").evaluate((el) => {
          const h = el.querySelector("h2")!.getBoundingClientRect(),
            s = el.querySelector(".otk-progress-status")!
              .getBoundingClientRect();
          return {
            heading: h.left,
            status: s.left,
            gap: Math.abs(h.left - s.left),
          };
        });
        await record(info, "panel-loading-" + theme, g);
        await shot(page, info, "panel-loading-" + theme);
        expect.soft(g.gap).toBeLessThanOrEqual(1);
        await audit(page, info, "loading-" + theme);
      }
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "release",
      });
      await expect(page.locator(".otk-session-loading-row")).toHaveCount(0);
      await expect(page.locator('[data-session="tstv1-core"]')).toBeVisible();
    },
  );
});

test.describe("native selected values", () => {
  test.use({ profile: "composer-applied" });
  test("visual.ui-rules-displayed-explicit-values-reach-native-unmuted", {
    tag: ["@visual", "@composer", "@contracts"],
  }, async ({ isolatedState: state, page }, info) => {
    test.setTimeout(180_000);
    const traffic = await wire(page);
    for (const theme of themes) {
      const session = await state.native<{ id: string }>("/session", "POST", {
        title: "UI rule value " + theme,
      });
      await openSession(state, page, session.id);
      await paint(state, page, theme);
      const trigger = page.locator(".otk-variant-picker > button");
      await expect(trigger).toHaveAttribute(
        "aria-label",
        "Variant: High (agent default)",
      );
      await expect(trigger).toHaveClass(/is-applied/);
      const applied = await trigger.evaluate((el) =>
        getComputedStyle(el).color
      );
      await trigger.click();
      await page.locator('.otk-variant-picker [data-picker-key="high"]')
        .click();
      await expect(trigger).toHaveAttribute("aria-label", "Variant: High");
      await expect(trigger).not.toHaveClass(/is-applied/);
      const explicit = await trigger.evaluate((el) => ({
        color: getComputedStyle(el).color,
        opacity: getComputedStyle(el).opacity,
      }));
      expect(explicit.color).not.toBe(applied);
      expect(explicit.opacity).toBe("1");
      const text = "UI audit exact value " + theme;
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        target: "selected",
        chunks: ["Received " + theme],
      });
      await page.locator('textarea[name="prompt"]').fill(text);
      await page.locator('textarea[name="prompt"]').press("Enter");
      await expect(page.locator('[data-role="assistant"] .otk-text'))
        .toContainText("Received " + theme);
      await expect(page.locator(`[data-session="${session.id}"]`))
        .toHaveAttribute("data-status", "idle");
      const sent = traffic.sent.filter(({ frame }) =>
        frame.method === "session.prompt" &&
        frame.params?.sessionID === session.id
      ).at(-1)!.frame.params!;
      expect(sent.variant).toBe("high");
      expect(sent.agent).toBe("reviewer");
      expect(sent.model).toEqual({ provider: "fake2", model: "scripted" });
      const messages = await state.native<
        { info: { role: string; model?: unknown } }[]
      >(`/session/${session.id}/message`);
      const v2 = state.controller.info!.version.startsWith("2.");
      const nativeModel = v2
        ? (await state.native<{ model: unknown }>(`/session/${session.id}`))
          .model
        : messages.find((row) => row.info.role === "user")!.info.model;
      expect(nativeModel).toEqual({
        providerID: "fake2",
        [v2 ? "id" : "modelID"]: "scripted",
        variant: "high",
      });
      await record(info, "values-" + theme, {
        applied,
        explicit,
        sent,
        native: nativeModel,
      });
      const toggle = page.locator(".otk-auto-approve-toggle");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(toggle).toHaveClass(/is-on/);
      await expect(toggle).not.toHaveClass(/is-selected/);
      await audit(page, info, "native-values-" + theme);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
    }
  });
});

test.describe("task and session chrome", () => {
  test.use({ profile: "contract-visual-inbox" });
  test(
    "visual.ui-rules-rail-icon-slots",
    tags,
    async ({ isolatedState: state, page }, info) => {
      await openSession(state, page, "tstv1-otk");
      await state.product("layout.patch", {
        leftCollapsed: true,
        rightCollapsed: true,
      });
      for (const theme of themes) {
        await paint(state, page, theme);
        await shot(page, info, "rail-icons-" + theme);
        await audit(page, info, "rail-icons-" + theme);
      }
    },
  );
  test(
    "visual.ui-rules-control-height-lamp-slots",
    tags,
    async ({ isolatedState: state, page }, info) => {
      await state.product("tasks.create", {
        directory: state.directory,
        name: "Execution",
        sessions: ["tstv1-otk", "tstv1-visual-1"],
      });
      await openSession(state, page, "tstv1-otk");
      for (const theme of themes) {
        await paint(state, page, theme);
        for (const size of [28, 40]) {
          await page.locator("html").evaluate(
            (el, size) =>
              (el as HTMLElement).style.setProperty(
                "--control-size",
                size + "px",
              ),
            size,
          );
          await settle(page);
          const values = await lamps(page);
          await record(info, `lamp-slots-${theme}-${size}`, values);
          expect(values.some((v) => v.selected)).toBe(true);
          expect(values.some((v) => v.id === "tstv1-otk")).toBe(true);
          if (size === 28) await shot(page, info, "chrome-" + theme);
          for (const v of values) {
            expect.soft(
              Math.max(...v.gaps) - Math.min(...v.gaps),
              JSON.stringify(v),
            ).toBeLessThanOrEqual(1);
            expect.soft(v.slot[0], JSON.stringify(v)).toBe(v.controlHeight);
            expect.soft(v.slot[1], JSON.stringify(v)).toBe(v.controlHeight);
            expect.soft(v.position).toBe("static");
            expect.soft(v.transform).toBe("none");
          }
        }
        await page.locator("html").evaluate((el) =>
          (el as HTMLElement).style.removeProperty("--control-size")
        );
        await audit(page, info, "normal-" + theme);
        await page.locator(".otk-display-menu > button").focus();
        await page.keyboard.press("Enter");
        await expect(page.locator(":popover-open")).toBeVisible();
        await audit(page, info, "display-" + theme);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Tab");
        await page.locator(".otk-tab-open[aria-selected=true]").focus();
        await expect(page.locator(".otk-tab-open[aria-selected=true]"))
          .toHaveCSS("outline-width", "2px");
        await expect(page.locator(".otk-tab-open[aria-selected=true]"))
          .toHaveCSS("outline-style", "solid");
        await audit(page, info, "focused-" + theme);
        for (const width of [600, 800, 1280, 1920]) {
          await state.product("layout.patch", {
            leftCollapsed: true,
            rightCollapsed: true,
          });
          await page.setViewportSize({ width, height: 800 });
          await settle(page);
          await audit(page, info, `rails-${theme}-${width}`);
          if (width === 1280) await shot(page, info, "rails-" + theme);
        }
        await page.setViewportSize({ width: 1280, height: 800 });
        await state.product("layout.patch", {
          leftCollapsed: false,
          rightCollapsed: false,
        });
      }
    },
  );
});

test.describe("mandatory helper crumbs", () => {
  test.use({ profile: "contract-sessions-tabs" });
  test(
    "visual.ui-rules-single-member-retains-phantom-helpers",
    tags,
    async ({ isolatedState: state, page }, info) => {
      await state.product("tasks.create", {
        directory: state.directory,
        name: "Execution",
        sessions: ["tstv1-otk"],
      });
      for (const sessionID of ["tstv1-helper", "tstv1-nested"]) {
        await state.controller.call("scenario", {
          lease: state.lease.lease,
          action: "hold",
          sessionID,
        });
      }
      await openSession(state, page, "tstv1-otk");
      for (const theme of themes) {
        await paint(state, page, theme);
        await expect(
          page.locator('[data-crumb="tstv1-helper"][data-helper=true]'),
        ).toBeVisible();
        await expect(
          page.locator('[data-crumb="tstv1-nested"][data-helper=true]'),
        ).toBeVisible();
        await audit(page, info, "helpers-" + theme);
      }
    },
  );
});
