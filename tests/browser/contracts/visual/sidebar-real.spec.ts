// SPDX-License-Identifier: LGPL-3.0-only
import { mkdirSync, writeFileSync } from "node:fs";
import { readableLabel, sidebarGeometry } from "./sidebar-geometry.ts";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { activity } from "../../pages/sessions.ts";
import { openSession } from "../../fixtures/wire.ts";
import type { TestState } from "../../fixtures/test-state.ts";

const OUT = process.env.OTK_STYLE7_CAPTURE_DIR;
const THEMES = [["otk-dark", "dark"], ["otk-light", "linen"], [
  "otk-light-stone",
  "stone",
]] as const;

function guard() {
  if (OUT) mkdirSync(OUT, { recursive: true });
}

async function sweep(
  state: TestState,
  page: import("@playwright/test").Page,
  profile: string,
  prepare: () => Promise<void>,
) {
  // Exercise WP10's optional artwork track and 2.109's whole-meta fit
  // against the real repository/discovery fixtures, not just the style scene.
  guard();
  const facts: unknown[] = [];
  await page.setViewportSize({ width: 1280, height: 860 });
  for (const width of [200, 298]) {
    for (const scale of ["100", "125"]) {
      await state.product("prefs.set", { key: "textSize", value: scale });
      await state.product("layout.patch", {
        leftWidth: width,
        leftCollapsed: false,
        rightCollapsed: true,
      });
      await page.reload();
      await prepare();
      await page.evaluate(() => document.fonts.ready);
      for (const [theme, label] of THEMES) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await page.mouse.move(1270, 850);
        facts.push({
          width,
          scale,
          theme,
          actualWidth: (await page.locator(".otk-project-inbox").boundingBox())
            ?.width,
          rows: await sidebarGeometry(page),
        });
        if (OUT) {
          await page.screenshot({
            path: `${OUT}/sidebar-${profile}-w${width}-s${scale}-${label}.png`,
            animations: "disabled",
          });
        }
      }
    }
  }
  await state.product("prefs.set", { key: "textSize", value: "125" });
  await state.product("layout.patch", {
    leftCollapsed: true,
    rightCollapsed: true,
  });
  await page.reload();
  for (const [theme, label] of THEMES) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await page.mouse.move(1270, 850);
    facts.push({
      collapsed: true,
      theme,
      rows: await sidebarGeometry(page, true),
    });
    if (OUT) {
      await page.screenshot({
        path: `${OUT}/collapsed-${profile}-s125-${label}.png`,
        animations: "disabled",
      });
    }
  }
  if (OUT) {
    writeFileSync(
      `${OUT}/facts-${profile}.json`,
      JSON.stringify(facts, null, 1),
    );
  }
}

const openAll = async (page: import("@playwright/test").Page) => {
  for (
    const name of [
      ".otk-archived-toggle",
      ".otk-inactive-toggle",
      ".otk-discovered-toggle",
    ]
  ) {
    const els = page.locator(name);
    for (let n = 0; n < await els.count(); n++) {
      if (await els.nth(n).getAttribute("aria-expanded") === "false") {
        await els.nth(n).click();
      }
    }
  }
};

test.describe("removed", () => {
  test.use({ profile: "contract-sessions-removed" });
  test("visual.sidebar-real.removed", {
    tag: ["@visual", "@projects", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    test.setTimeout(240000);
    const { entries } = await state.observe<
      { entries: { directory: string }[] }
    >();
    await page.goto(state.url);
    // Select the repository root (avatar + disclosure): the hardest lamp/selection case.
    await page.locator(
      `.otk-project-row[data-project=${
        JSON.stringify(entries[0].directory)
      }] .otk-project-open`,
    ).click();
    await sweep(state, page, "removed", () => openAll(page));
  });
});

test.describe("sidebar", () => {
  test.use({ profile: "contract-sessions-sidebar" });
  test("visual.sidebar-real.sidebar", {
    tag: ["@visual", "@projects", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    test.setTimeout(240000);
    const { root } = await state.observe<{ root: string }>();
    await page.goto(state.url);
    const child = page.locator(
      `.otk-project-row[data-project=${
        JSON.stringify(root + "/sidebar/all-required-child-0")
      }] .otk-project-open`,
    );
    if (await child.count()) await child.click();
    await sweep(state, page, "sidebar", () => openAll(page));
  });
});

test.describe("catalog", () => {
  test.use({ profile: "contract-sessions-catalog" });
  test("visual.sidebar-real.catalog", {
    tag: ["@visual", "@projects", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    test.setTimeout(240000);
    await page.goto(state.url);
    await openAll(page);
    const discovered = page.locator(
      ".otk-discovered-projects .otk-project-open",
    ).first();
    if (await discovered.count()) await discovered.click();
    await sweep(state, page, "catalog", () => openAll(page));
  });
});

test.describe("composer", () => {
  test.use({ profile: "contract-sessions-default" });
  test("visual.sidebar-real.composer", {
    tag: ["@visual", "@composer", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    test.setTimeout(240000);
    guard();
    const taskName =
      "Sticky selected task: review the destination before sending a message to the intended conversation";
    await state.product("tasks.create", {
      directory: state.directory,
      name: taskName,
      sessions: ["tstv1-otk"],
    });
    await activity(state, "tstv1-urgent-child", "hold");
    await openSession(state, page, "tstv1-otk");
    const facts: unknown[] = [];
    for (const [vw, scale] of [[1280, "100"], [900, "125"]] as const) {
      await page.setViewportSize({ width: vw, height: 800 });
      await state.product("prefs.set", { key: "textSize", value: scale });
      await expect(page.locator(".otk-composer-target")).toBeVisible();
      for (const [theme, label] of THEMES) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await page.mouse.move(vw - 5, 795);
        facts.push({
          vw,
          scale,
          theme,
          header: await page.locator(".otk-composer-target").evaluate((el) => {
            const row = el.parentElement!;
            const kids = Array.from(row.children).map((c) => {
              const r = c.getBoundingClientRect(), s = getComputedStyle(c);
              return {
                cls: c.className,
                text: c.textContent,
                x: r.x,
                r: r.right,
                y: r.y,
                b: r.bottom,
                color: s.color,
                font: s.fontSize,
                weight: s.fontWeight,
                ws: s.whiteSpace,
                to: s.textOverflow,
                title: c.getAttribute("title"),
              };
            });
            return {
              html: row.outerHTML.slice(0, 1500),
              kids,
              scroll: el.scrollWidth,
              client: el.clientWidth,
            };
          }),
        });
        const destination = page.locator(".otk-composer-target");
        await expect.soft(destination.locator("svg")).toHaveCount(0);
        await expect.soft(destination.locator(".otk-composer-separator"))
          .toHaveText("·");
        const sessionLabel = destination.locator(".otk-composer-destination");
        expect.soft(await sessionLabel.allTextContents()).toEqual([
          "Execution",
        ]);
        if (await sessionLabel.count()) {
          expect.soft(
            await sessionLabel.evaluate((el) =>
              el.scrollWidth - el.clientWidth
            ),
            "destination session stays fully readable",
          ).toBeLessThanOrEqual(1);
        }
        const footerLines = await page.locator(
          ".otk-prompt-context:not([inert] *)",
        ).evaluate(
          (root) => {
            const walker = document.createTreeWalker(
                root,
                NodeFilter.SHOW_TEXT,
              ),
              rows: number[] = [];
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (!node.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const r of Array.from(range.getClientRects())) {
                if (r.width > 0) rows.push(r.y);
              }
            }
            return rows.length ? Math.max(...rows) - Math.min(...rows) : 0;
          },
        );
        expect.soft(
          footerLines,
          "footer label text stays on one baseline, including the plain Default agent fallback",
        ).toBeLessThanOrEqual(1);
        const crumbs = page.locator(
          ".otk-session-crumb:visible .otk-crumb-title",
        );
        for (const crumb of await crumbs.all()) {
          const painted = await crumb.evaluate(readableLabel);
          expect.soft(
            painted.visible,
            "a breadcrumb's readable title is not clipped by a shrinking frame",
          ).toBeGreaterThanOrEqual(painted.minimum - .5);
          expect.soft(
            await crumb.evaluate((el) => el.getBoundingClientRect().width),
            "breadcrumb keeps a readable title, not just its lamp",
          ).toBeGreaterThanOrEqual(32 * Number(scale) / 100);
        }
        if (OUT) {
          await page.screenshot({
            path: `${OUT}/composer-w${vw}-s${scale}-${label}.png`,
            animations: "disabled",
          });
        }
      }
    }
    if (OUT) {
      writeFileSync(
        `${OUT}/facts-composer.json`,
        JSON.stringify(facts, null, 1),
      );
    }
  });
});
