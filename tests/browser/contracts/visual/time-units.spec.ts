// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { sidebarGeometry } from "./sidebar-geometry.ts";

test.use({ profile: "contract-visual-styles" });

const themes = ["otk-dark", "otk-light", "otk-light-stone"] as const;
const tags = { tag: ["@visual", "@sessions", "@isolated"] };
const projectRows = ".otk-project-row";
const helperRows = ".otk-subagent-row";
const sidebarScene = "?scene=sidebar-rows&width=360";
const subagentsScene = "?scene=uiconv&surface=subagents";

async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
}

async function paint(page: Page, theme: string, scale: number) {
  await page.evaluate(`styleTest.theme(${JSON.stringify(theme)})`);
  await page.evaluate(async (scale) => {
    document.documentElement.style.setProperty("--otk-scale", String(scale));
    await document.fonts.ready;
  }, scale);
  await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
}

async function openList(page: Page, url: string) {
  await page.clock.setFixedTime(new Date("2026-11-20T01:23:00.107-08:00"));
  await open(page, url + subagentsScene);
  await page.getByRole("button", {
    name: "Subagents: 1 needs you, 1 finished, 3 running",
    exact: true,
  }).click();
  await expect(page.getByRole("menu", { name: "Subagents", exact: true }))
    .toBeVisible();
}

async function aligned(rows: Locator, info: TestInfo, name: string) {
  const samples = await rows.evaluateAll((rows) =>
    rows.flatMap((row) => {
      const time = row.querySelector("time.otk-time");
      if (!time || getComputedStyle(time).visibility !== "visible") return [];
      const lastValue = Array.from(
        time.querySelectorAll(".otk-time-part .otk-time-value"),
      ).at(-1);
      return [{
        text: time.textContent,
        digit: lastValue?.getBoundingClientRect().right,
        right: time.getBoundingClientRect().right,
        rowRight: row.getBoundingClientRect().right,
      }];
    })
  );
  await info.attach(name, {
    body: JSON.stringify(samples, null, 2),
    contentType: "application/json",
  });
  const digits = samples.flatMap(({ digit }) =>
    digit === undefined ? [] : [digit]
  );
  expect(digits.length).toBeGreaterThanOrEqual(4);
  expect.soft(Math.max(...digits) - Math.min(...digits), name)
    .toBeLessThanOrEqual(.5);
  for (const { text, right, rowRight } of samples) {
    expect.soft(right - rowRight, `${name}: ${text} stays in its row`)
      .toBeLessThanOrEqual(.5);
  }
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`time-units-${name}-125.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("visual.time-units-digits-share-one-edge", tags, async (
  { isolatedState: state, page },
  info,
) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  await open(page, state.url + sidebarScene);
  const hover = page.locator('[data-project="/projects/atmosphera.branch"]');
  for (const theme of themes) {
    for (const scale of [1, 1.25]) {
      await page.mouse.move(0, 0);
      await paint(page, theme, scale);
      await aligned(
        page.locator(projectRows),
        info,
        `sidebar-${theme}-${scale}`,
      );
      if (scale === 1.25) {
        await hover.hover();
        await expect(hover.locator("time")).toBeHidden();
        await expect(hover.locator(".otk-project-menu")).toHaveCSS(
          "opacity",
          "1",
        );
        await screenshot(page, info, `sidebar-${theme}`);
      }
    }
  }

  await openList(page, state.url);
  for (const theme of themes) {
    for (const scale of [1, 1.25]) {
      await paint(page, theme, scale);
      await aligned(
        page.locator(helperRows),
        info,
        `subagents-${theme}-${scale}`,
      );
      if (scale === 1.25) await screenshot(page, info, `subagents-${theme}`);
    }
  }
});

test("visual.time-units-unit-ladder", tags, async (
  { isolatedState: state, page },
) => {
  await openList(page, state.url);
  const times = page.locator(`${helperRows} time`);
  await expect(times).toHaveCount(4);
  await expect(page.locator(`${helperRows} .is-selected`)).toHaveCount(1);
  for (const theme of themes) {
    await paint(page, theme, 1.25);
    const samples = await times.evaluateAll((times) =>
      times.map((time) => {
        const probe = document.createElement("span");
        time.append(probe);
        function color(token: string) {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        }
        const fg = color("--otk-fg"), accent = color("--otk-accent-text");
        probe.remove();
        return {
          selected: !!time.closest(".otk-subagent-row")!.querySelector(
            ".is-selected",
          ),
          numeric: getComputedStyle(time).fontVariantNumeric,
          fg,
          accent,
          values: Array.from(
            time.querySelectorAll(".otk-time-value"),
            (el) => ({
              color: getComputedStyle(el).color,
              weight: getComputedStyle(el).fontWeight,
            }),
          ),
          units: Array.from(time.querySelectorAll(".otk-time-unit"), (el) => ({
            unit: el.getAttribute("data-unit"),
            color: getComputedStyle(el).color,
            weight: getComputedStyle(el).fontWeight,
            gap: parseFloat(getComputedStyle(el).marginInlineStart),
            size: parseFloat(getComputedStyle(el).fontSize),
          })),
        };
      })
    );
    expect(samples.some((row) => row.selected)).toBe(true);
    for (const row of samples) {
      expect.soft(row.numeric).toContain("tabular-nums");
      expect.soft(row.accent).not.toBe(row.fg);
      for (const value of row.values) {
        expect.soft(value).toEqual({ color: row.fg, weight: "400" });
      }
      for (const unit of row.units) {
        expect.soft(unit.color).toBe(
          unit.unit === "h" || unit.unit === "d" ? row.accent : row.fg,
        );
        expect.soft(unit.weight).toBe("600");
        expect.soft(unit.gap / unit.size).toBeCloseTo(.12, 3);
      }
    }
    expect(
      [...new Set(samples.flatMap((row) => row.units.map(({ unit }) => unit)))]
        .sort(),
    )
      .toEqual(["d", "h", "m", "s"]);
  }
});

test("visual.time-units-accessible-text", tags, async (
  { isolatedState: state, page },
) => {
  // Inspect Chromium's native time mapping: Playwright's role matcher omits
  // the accessible name of <time> even when Chromium exposes it.
  async function exposesTime(name: string) {
    const cdp = await page.context().newCDPSession(page);
    try {
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      expect(
        nodes.some((node) =>
          !node.ignored && node.role?.value === "time" &&
          node.name?.value === name
        ),
      ).toBe(true);
    } finally {
      await cdp.detach();
    }
  }
  await open(page, state.url + sidebarScene);
  const visit = page.locator('[data-project="/projects/ndash"] time');
  await expect(visit).toHaveText("15h");
  await exposesTime("15 hours ago");
  await openList(page, state.url);
  const run = page.locator(helperRows).filter({
    hasText: "Explore: find time formatters",
  }).locator("time");
  await expect(run).toHaveText("2m 54.7s");
  await exposesTime("2 minutes, 54.7 seconds");
  await expect(page.getByText("Time unknown", { exact: true })).toBeVisible();
});

test("visual.time-units-labels-never-wrap", tags, async (
  { isolatedState: state, page },
) => {
  await open(page, state.url + "?scene=sidebar-rows&width=200");
  for (const theme of themes) {
    await paint(page, theme, 1.25);
    await sidebarGeometry(page);
  }
});
