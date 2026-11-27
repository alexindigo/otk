// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxSnapshot, IndexEntry } from "@otk/protocol";
import type { CDPSession, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { expect } from "../fixtures/evidence.ts";
import { isolatedTest as test } from "../fixtures/isolated.ts";
import type { TestState } from "../fixtures/test-state.ts";
import { wire } from "../fixtures/wire.ts";
import { selectionGeometry } from "../../support/selection-geometry.ts";
import { collections456 } from "./collections.ts";
import { collections789 } from "./overlays.ts";
import { remainder } from "./remainder.ts";
import { nativeStates } from "./native-states.ts";
import { supplemental } from "./supplemental.ts";
import { capture, restoreViewport } from "./capture.ts";
import { stripGeometry } from "../pages/task-strip.ts";
import { assertCrumbCoverage } from "../pages/crumbs.ts";
import { cssLength } from "../pages/css-length.ts";

test.use({ profile: "contract-themes" });
interface Theme {
  id: string;
  mode: string;
  colors: Record<string, string>;
}
const ids = Array.from({ length: 11 }, (_, i) => `tstv1-visual-${i + 1}`)
  .concat("tstv1-otk");
async function settled(page: Page) {
  await page.evaluate(() =>
    document.fonts.ready.then(() =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    )
  );
}
async function tokens(page: Page, theme: Theme) {
  await expect(page.locator("html")).toHaveAttribute(
    "data-otk-theme",
    theme.id,
  );
  await expect.poll(() =>
    page.locator("html").evaluate((el) => {
      const css = getComputedStyle(el);
      return Object.fromEntries(
        Array.from(css).filter((key) => key.startsWith("--otk-")).map((
          key,
        ) => [key.slice(6), css.getPropertyValue(key).trim()]),
      );
    })
  ).toMatchObject(theme.colors);
  expect(
    await page.locator("html").evaluate((el) =>
      getComputedStyle(el).colorScheme
    ),
  ).toBe(theme.mode);
}
async function layout(
  state: TestState,
  page: Page,
  left: boolean,
  right: boolean,
  leftWidth = 248,
) {
  await state.product("layout.patch", {
    leftCollapsed: left,
    rightCollapsed: right,
    leftWidth,
    rightWidth: 320,
    rightView: "sessions",
  });
  await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
    "data-collapsed",
    String(left),
  );
  const panel = page.locator('aside.otk-sidebar-rail[data-side="right"]');
  await expect(panel).toHaveCount(1);
  await expect(panel).toHaveAttribute("data-collapsed", String(right));
  await expect(panel).toBeVisible();
  await settled(page);
}
async function centers(page: Page, selector: string, a: string, b: string) {
  const deltas = await page.locator(selector).evaluateAll(
    (rows, { a, b }) =>
      rows.map((row) => {
        const x = row.querySelector(a)!.getBoundingClientRect(),
          y = row.querySelector(b)!.getBoundingClientRect();
        return Math.abs(x.y + x.height / 2 - y.y - y.height / 2);
      }),
    { a, b },
  );
  expect(deltas.length).toBeGreaterThan(0);
  for (const delta of deltas) expect(delta).toBeLessThanOrEqual(.5);
}
async function marks(
  page: Page,
  cdp: CDPSession,
  targets: readonly string[],
) {
  for (const target of targets) {
    await expect(page.locator(target)).toBeVisible();
  }
  const items = await selectionGeometry({
    send: (method, params = {}) =>
      cdp.send(method as Parameters<CDPSession["send"]>[0], params),
  }, targets.join(","));
  expect(items).toHaveLength(targets.length);
  for (const item of items) {
    expect(item.shift).toBe(0);
    expect(item.position).toBe("static");
    if (item.orientation === "vertical") {
      expect([item.w, item.h]).toEqual([3, 14]);
      expect(item.centred).toBeLessThanOrEqual(.5);
    } else {expect([item.h, item.start, item.end, item.bottom]).toEqual([
        2,
        8,
        8,
        0,
      ]);}
    expect(item.paint === "rgba(0, 0, 0, 0)").toBe(!item.selected);
    if (item.selected) {
      expect(item.ariaCurrent === "page" || item.ariaSelected === "true").toBe(
        true,
      );
    }
  }
  await expect(
    page.locator(".otk-tab [popover],.otk-tab button[popovertarget]"),
  ).toHaveCount(0);
}

test(
  "themes.panes-chrome-rows",
  {
    tag: [
      "@visual",
      "@sessions",
      "@transport",
      "@scale",
      "@themes",
      "@composer",
      "@attention",
      "@messages",
      "@revert",
      "@menus",
    ],
  },
  async ({ isolatedState: state, page, context }, info) => {
    // One ordered owner retains all nine collections of full-frame evidence.
    test.setTimeout(1_500_000);
    const facts = await state.observe<
      {
        scenes: string;
        native: {
          url: string;
          sessionID: string;
          emptyID: string;
          automaticID: string;
        };
        entries: { id: string; directory: string }[];
        lists: { entries: IndexEntry[]; inbox: InboxSnapshot };
        content: { sessionID: string };
      }
    >();
    const manifest =
      await (await page.request.get(facts.scenes + "/manifest.json"))
        .json() as { schema: number; themes: Theme[] };
    expect(manifest.schema).toBe(1);
    expect(manifest.themes.map((t) => t.id)).toEqual([
      "otk-dark",
      "otk-light",
      "otk-light-stone",
    ]);
    const checked = JSON.parse(
      await readFile(new URL("./states.json", import.meta.url), "utf8"),
    );
    expect(checked.collections).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const witnessed = new Set<string>();
    const traffic = await wire(page);
    await page.addInitScript(() => {
      // Keep fixture dates reproducible without freezing elapsed-time deadlines
      // (including the code renderer's worker capture admission).
      const origin = performance.now();
      Date.now = () => 1793736000000 + Math.floor(performance.now() - origin);
    });
    const cdp = await context.newCDPSession(page);
    await state.product("prefs.set", { key: "animationsOff", value: true });
    await state.product("prefs.set", { key: "reducedColors", value: false });
    const task = await state.product("tasks.create", {
      directory: state.directory,
      name: "Geometry task",
      sessions: ids,
    });
    const empty = await state.product("tasks.create", {
      directory: state.directory,
      name: "Empty task",
    });
    async function paint(theme: Theme) {
      const before = traffic.received.length;
      await state.product("prefs.set", { key: "theme", value: theme.id });
      await expect.poll(() =>
        traffic.received.slice(before).some((event) =>
          event.t === "prefs" &&
          (event.prefs as { theme: string }).theme === theme.id
        )
      ).toBe(true);
      await tokens(page, theme);
      expect((await state.product("prefs.get", {})).theme).toBe(theme.id);
    }
    async function shot(name: string) {
      witnessed.add(name);
      await capture(page, cdp, info, name);
    }
    try {
      // The real compact corpus is acquired once. Component scenes below make no
      // claims about stock-native loading, error or external backend semantics.
      await test.step("1/native-session", async () => {
        await page.goto(
          facts.native.url + "/#/local/" + facts.native.sessionID,
        );
        await expect(page.locator(".otk-text")).toContainText(
          "Fixed native source for theme evidence",
        );
        for (const theme of manifest.themes) {
          await test.step(theme.id, async () => {
            await paint(theme);
            await shot(`native-session-${theme.id}-1280`);
          });
        }
      });
      await test.step("1/native-empty-and-deleted", async () => {
        await page.goto(facts.native.url + "/#/local/" + facts.native.emptyID);
        const empty = page.locator(".otk-messages p.otk-muted");
        await expect(empty).toHaveText("Start a conversation below.");
        for (const theme of manifest.themes) {
          await test.step("empty/" + theme.id, async () => {
            await paint(theme);
            const delta = await empty.evaluate((el) => {
              // PaneState centres one left-aligned content group, not each
              // line of text independently.
              const a = el.closest(".otk-messages")!.getBoundingClientRect(),
                b = el.closest(".otk-pane-state-content")!
                  .getBoundingClientRect();
              return [
                Math.abs((a.left + a.right - b.left - b.right) / 2),
                Math.abs((a.top + a.bottom - b.top - b.bottom) / 2),
              ];
            });
            for (const d of delta) {
              expect(d).toBeLessThanOrEqual(1);
            }
            await expect(empty).toHaveCSS("text-align", "left");
            await shot(`native-empty-${theme.id}-1280`);
          });
        }
        await page.goto(
          facts.native.url + "/#/local/" + facts.native.sessionID,
        );
        await expect(page.locator(".otk-text")).toContainText(
          "Fixed native source",
        );
        await state.native(`/session/${facts.native.sessionID}`, "DELETE");
        await expect(page.locator(".otk-deleted-session")).toBeVisible();
        for (const theme of manifest.themes) {
          await test.step("deleted/" + theme.id, async () => {
            await paint(theme);
            const contrast = await page.locator(
              `[data-session="${facts.native.sessionID}"] .otk-session-title`,
            ).evaluate((title) => {
              const css = getComputedStyle(document.documentElement),
                canvas = document.createElement("canvas");
              canvas.width = canvas.height = 1;
              const ctx = canvas.getContext("2d")!;
              const lum = (color: string) => {
                ctx.clearRect(0, 0, 1, 1);
                ctx.fillStyle = css.getPropertyValue("--otk-bg-side");
                ctx.fillRect(0, 0, 1, 1);
                ctx.fillStyle = color;
                ctx.fillRect(0, 0, 1, 1);
                return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
                  .map((n) => n / 255).map((n) =>
                    n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4
                  ).reduce(
                    (sum, n, i) => sum + n * [.2126, .7152, .0722][i],
                    0,
                  );
              };
              const fg = lum(getComputedStyle(title).color);
              return ["--otk-bg", "--otk-bg-side", "--otk-selected"].map(
                (key) => {
                  const bg = lum(css.getPropertyValue(key));
                  return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
                },
              );
            });
            for (const ratio of contrast) {
              expect(ratio).toBeGreaterThanOrEqual(4.5);
            }
            await shot(`native-deleted-${theme.id}-1280`);
          });
        }
      });
      await page.goto(state.url + "/#/local/tstv1-otk");
      await expect(page.locator(".otk-session-view")).toBeVisible();
      await test.step("1/empty-project-session-panes", async () => {
        await page.locator(`[data-tab="${empty.id}"]`).click();
        await expect(page.locator(".otk-welcome h1")).toBeVisible();
        for (const theme of manifest.themes) {
          await test.step(theme.id, async () => {
            await paint(theme);
            for (const zoom of [1, 2]) {
              for (const physical of [600, 800, 1280, 1920]) {
                await test.step(`${physical}@${zoom}`, async () => {
                  await page.setViewportSize({
                    width: physical / zoom,
                    height: 800 / zoom,
                  });
                  await cdp.send("Emulation.setDeviceMetricsOverride", {
                    width: physical / zoom,
                    height: 800 / zoom,
                    deviceScaleFactor: zoom,
                    mobile: false,
                  });
                  await layout(state, page, true, true);
                  await expect(page.locator(".otk-welcome h1")).toBeVisible();
                  for (
                    const collapsed of physical / zoom >= 1280
                      ? [true, false]
                      : [true]
                  ) {
                    await layout(state, page, collapsed, collapsed);
                    const deltas = await page.locator(".otk-welcome").evaluate(
                      (el) => {
                        const pane = el.getBoundingClientRect(),
                          group = el.querySelector(".otk-pane-state-content")!
                            .getBoundingClientRect();
                        return [
                          Math.abs(
                            (pane.left + pane.right - group.left -
                              group.right) / 2,
                          ),
                          Math.abs(
                            (pane.top + pane.bottom - group.top -
                              group.bottom) / 2,
                          ),
                        ];
                      },
                    );
                    for (const delta of deltas) {
                      expect(delta).toBeLessThanOrEqual(1);
                    }
                  }
                  await shot(`empty-${theme.id}-${physical}-zoom${zoom}`);
                });
              }
            }
          });
        }
      });
      await restoreViewport(page, cdp);
      await page.setViewportSize({ width: 1280, height: 900 });
      await test.step("1/public-loading-reconnecting-error-deleted", async () => {
        await page.goto(
          facts.scenes + "/?server=" + encodeURIComponent(state.url),
        );
        await expect(page.locator("main")).toHaveAttribute(
          "data-ready",
          "true",
        );
        for (const theme of manifest.themes) {
          await test.step(theme.id, async () => {
            await paint(theme);
            for (const id of ["loading", "reconnecting", "error"]) {
              const pane = page.locator(`[data-pane=${id}]`),
                body = pane.locator(".theme-pane-body");
              await expect(body).toHaveAttribute(
                "aria-busy",
                String(id === "loading"),
              );
              const status = pane.getByRole(
                id === "error" ? "alert" : "status",
              );
              // Errors use the shared structured presenter. Its reason remains
              // exact, alongside the action, target and Details disclosure.
              await expect(
                id === "error" ? status.locator(".otk-failure-reason") : status,
              ).toHaveText(
                id === "loading"
                  ? "Loading messages"
                  : id === "error"
                  ? "Could not load this conversation"
                  : "Reconnecting. Retaining loaded conversation",
              );
              const delta = await body.evaluate((el) => {
                const a = el.getBoundingClientRect(),
                  b = el.querySelector(".otk-pane-state-content")!
                    .getBoundingClientRect();
                return [
                  Math.abs((a.left + a.right - b.left - b.right) / 2),
                  Math.abs((a.top + a.bottom - b.top - b.bottom) / 2),
                ];
              });
              for (const d of delta) expect(d).toBeLessThanOrEqual(.5);
              if (id !== "loading") {
                await expect(pane).toContainText(
                  "Retained source: const answer = 42;",
                );
              }
            }
            await expect(
              page.getByRole("region", {
                name: "Deleted session",
                exact: true,
              }),
            ).toContainText("Keep my unsent source");
            await expect(page.locator("[data-pane=deleted] dd")).toHaveText(
              "Unknown",
            );
            await shot(`public-panes-${theme.id}-1280`);
          });
        }
      });
      await page.goto(state.url + "/#/local/tstv1-otk/tstv1-child");
      await expect(page.locator(".otk-session-crumb[aria-current]"))
        .toBeVisible();
      await test.step("2/chrome-projects", async () => {
        let cornerBaseline: number[][] | undefined;
        for (const theme of manifest.themes) {
          await test.step(theme.id, async () => {
            await paint(theme);
            for (const reduced of [false, true]) {
              await state.product("prefs.set", {
                key: "reducedColors",
                value: reduced,
              });
              await expect.poll(() =>
                page.locator("html").evaluate((el) =>
                  el.hasAttribute("data-otk-reduced-colors")
                )
              ).toBe(reduced);
              let lights: number[] | undefined;
              for (
                const [left, right] of [[false, false], [true, false], [
                  false,
                  true,
                ], [true, true]]
              ) {
                await test.step(`${left}/${right}/reduced=${reduced}`, async () => {
                  await layout(state, page, left, right);
                  const corners = await page.evaluate(() =>
                    [".otk-corner-left", ".otk-corner-right"].map(
                      (selector) => {
                        const el = document.querySelector(selector)!,
                          r = el.getBoundingClientRect();
                        if (
                          !el.contains(
                            document.elementFromPoint(
                              r.x + r.width / 2,
                              r.y + r.height / 2,
                            ),
                          )
                        ) {
                          throw Error("Covered corner");
                        }
                        return [r.x, r.y, r.width, r.height];
                      },
                    )
                  );
                  cornerBaseline ??= corners;
                  corners.forEach((r, i) =>
                    r.forEach((v, j) =>
                      expect(Math.abs(v - cornerBaseline![i][j]))
                        .toBeLessThanOrEqual(.5)
                    )
                  );
                  const ys = await page.locator(".otk-project-inbox")
                    .evaluate((inbox) => {
                      const centre = (el: Element) => {
                        const r = el.getBoundingClientRect();
                        return r.y + r.height / 2;
                      };
                      // D71 stacks history ahead of the search control in the
                      // narrow rail. That moves the section, not its row grid.
                      const origin = centre(
                        inbox.querySelector(".otk-inbox-search")!,
                      );
                      return Array.from(
                        inbox.querySelectorAll(
                          ".otk-project-row[data-inactive=false] .otk-status-light",
                        ),
                        (lamp) => centre(lamp) - origin,
                      );
                    });
                  lights ??= ys;
                  expect(ys).toEqual(lights);
                  expect(
                    (await page.locator(".otk-project-inbox").boundingBox())!
                      .width,
                  ).toBe(left ? 48 : 248);
                  for (
                    const [id, status] of [["otk", "blocked"], [
                      "discovered",
                      "working",
                    ], [
                      "atmosphera",
                      "blocked",
                    ], ["globnotes", "finished"]]
                  ) {
                    await expect(
                      page.locator(
                        `[data-project$="/projects/${id}"] [data-state=${status}]`,
                      ),
                    ).toBeVisible();
                  }
                  await expect(page.locator('[data-tab="tstv1-blocked"]'))
                    .toBeVisible();
                  for (const id of ["working", "finished"]) {
                    await expect(page.locator(`[data-tab="tstv1-${id}"]`))
                      .toBeVisible();
                  }
                  await expect(page.locator('[data-tab="tstv1-blocked"]'))
                    .toHaveCSS("font-style", "italic");
                  if (left && right) {
                    expect(
                      await page.locator(
                        ".otk-sidebar-rail[data-collapsed=true]",
                      ).evaluateAll((els) =>
                        els.map((el) => el.getBoundingClientRect().width)
                      ),
                    ).toEqual([48, 48]);
                    expect(
                      await page.evaluate(() => {
                        const l = document.querySelector(".otk-project-inbox")!
                            .getBoundingClientRect(),
                          r = document.querySelector(".otk-right-rail")!
                            .getBoundingClientRect();
                        return l.left === 0 && r.right === innerWidth &&
                          l.height === innerHeight && r.height === innerHeight;
                      }),
                    ).toBe(true);
                  }
                  if (!left) {
                    const labels = await page.locator(".otk-project-name-line")
                      .evaluateAll((els) =>
                        els.map((el) => el.getBoundingClientRect().left)
                      );
                    expect(Math.max(...labels) - Math.min(...labels))
                      .toBeLessThanOrEqual(.5);
                    const inactive = page.locator(".otk-inactive-toggle");
                    if (
                      await inactive.getAttribute("aria-expanded") === "false"
                    ) await inactive.click();
                    await expect(
                      page.locator(".otk-inactive-projects [data-project]"),
                    ).toBeVisible();
                    // Rows are never lampless; no evidence renders grey.
                    await expect(
                      page.locator(".otk-project-row").filter({
                        hasText: "empty",
                      }).locator(".otk-status-light"),
                    ).toHaveAttribute("data-state", "none");
                  }
                  expect(
                    await page.evaluate(() => {
                      const a = document.querySelector(".otk-project-inbox")!
                          .getBoundingClientRect(),
                        b = document.querySelector(".otk-main")!
                          .getBoundingClientRect();
                      return [
                        Math.abs(a.right - b.left),
                        Math.abs(innerHeight - b.bottom),
                      ];
                    }),
                  ).toEqual([0, 0]);
                  await expect(page.locator(".otk-inbox-search"))
                    .toHaveAttribute("aria-label", "Search commands");
                  expect(
                    await page.locator(
                      '[data-crumb="tstv1-otk"] .otk-status-light',
                    ).evaluate((el) => el.getBoundingClientRect().width),
                  ).toBe(8);
                  if (reduced) {
                    await expect(
                      page.locator('[data-crumb="tstv1-otk"] .otk-lamp-shape'),
                    ).toHaveCSS("display", "block");
                  }
                  expect(
                    await page.locator(
                      '[data-tab="tstv1-blocked"] .otk-lamp-body',
                    ).evaluate((el) => {
                      let opacity = 1;
                      for (let e: Element | null = el; e; e = e.parentElement) {
                        opacity *= Number(getComputedStyle(e).opacity);
                      }
                      return opacity;
                    }),
                  ).toBe(1);
                  // The selected session is marked in the Sessions panel,
                  // not a second time in its ancestry trail or closed menu.
                  const activeMark = "[data-otk-selection].is-selected";
                  await marks(page, cdp, [
                    `.otk-project-row[data-project$="/projects/otk"]${activeMark}`,
                    `[data-tab="${task.id}"][data-open-session="tstv1-child"]${activeMark}`,
                    `${
                      right ? ".otk-right-rail" : ".otk-panel-icons"
                    } [data-panel-view="sessions"]${activeMark}`,
                    ...(right ? [] : [
                      `.otk-project-sessions [data-session="tstv1-child"]${activeMark}`,
                    ]),
                  ]);
                  expect(
                    await page.evaluate(() =>
                      !!document.querySelector(
                        ".otk-session-view .otk-view-header,.otk-shell-toolbar",
                      ) ||
                      Array.from(
                        document.querySelectorAll<HTMLElement>(
                          ".otk-project-inbox,.otk-project-tabs,.otk-right-panel",
                        ),
                      ).some((el) =>
                        /Ctrl[+ ]|Enter to send|j\/k select|Agent service connected/
                          .test(el.innerText)
                      )
                    ),
                  ).toBe(false);
                  if (right) {
                    expect(
                      await page.locator(".otk-right-rail [data-panel-view]")
                        .evaluateAll((els) =>
                          els.map((el) => el.getAttribute("data-panel-view"))
                        ),
                    ).toEqual(["sessions", "timeline", "external-view"]);
                    expect(
                      await page.locator(".otk-right-rail [data-panel-view]")
                        .evaluateAll((els) => {
                          const r = els.map((el) => el.getBoundingClientRect());
                          return r[0].y >= 52 &&
                            r.slice(1).every((a, i) =>
                              a.y >= r[i].bottom && Math.abs(a.x - r[i].x) < .5
                            );
                        }),
                    ).toBe(true);
                  }
                  await shot(
                    `chrome-${left ? "left-rail" : "left-full"}-${
                      right ? "right-rail" : "right-full"
                    }-${theme.id}-reduced${reduced}`,
                  );
                });
              }
            }
            await layout(state, page, true, true, 360);
            expect(
              (await page.locator(".otk-project-inbox").boundingBox())!.width,
            ).toBe(48);
            await layout(state, page, false, false, 360);
            expect(
              (await page.locator(".otk-project-inbox").boundingBox())!.width,
            ).toBe(360);
            await layout(state, page, true, true);
            const measure = () =>
              page.evaluate(() => {
                const r = (s: string) =>
                  document.querySelector(s)!.getBoundingClientRect();
                return [
                  r(".otk-project-inbox").width,
                  r(".otk-right-rail").width,
                  r(".otk-rail-header").height,
                  r(".otk-inbox-brand").height,
                  r(".otk-task-strip").height,
                  r(".otk-corner-left").width,
                  r(".otk-corner-left").height,
                  r(".otk-display-trigger").width,
                  r(".otk-server-status").height,
                  r(".otk-corner-left").top + r(".otk-corner-left").height / 2,
                  r(".otk-corner-left").x,
                  innerWidth - r(".otk-corner-right").right,
                ];
              });
            expect(await measure()).toEqual([
              48,
              48,
              52,
              52,
              52,
              28,
              28,
              28,
              28,
              26,
              12,
              12,
            ]);
            await page.locator("html").evaluate((el) => {
              const s = (el as HTMLElement).style;
              s.setProperty("--rail-width", "64px");
              s.setProperty("--chrome-header-height", "68px");
              s.setProperty("--control-size", "36px");
            });
            expect(await measure()).toEqual([
              64,
              64,
              68,
              68,
              68,
              36,
              36,
              36,
              36,
              34,
              12,
              12,
            ]);
            await layout(state, page, false, false);
            expect(
              await page.locator('[data-project$="/projects/atmosphera"]')
                .evaluate((row) => {
                  const sample = document.createElement("span");
                  sample.style.color = "var(--otk-fg-2)";
                  document.body.append(sample);
                  const expected = getComputedStyle(sample).color;
                  sample.remove();
                  return [row, row.querySelector(".otk-project-open")!].every((
                    el,
                  ) => getComputedStyle(el).color === expected);
                }),
            ).toBe(true);
            expect(
              await page.locator(".otk-panel-icons").evaluate((
                el,
              ) => [
                el.getBoundingClientRect().height,
                document.querySelector(".otk-corner-right")!
                  .getBoundingClientRect().left -
                el.getBoundingClientRect().right,
              ]),
            ).toEqual([68, 8]);
            await page.locator("html").evaluate((el) =>
              ["--rail-width", "--chrome-header-height", "--control-size"]
                .forEach((k) => (el as HTMLElement).style.removeProperty(k))
            );
          });
        }
      });
      await test.step("2/resize-input-contract-once", async () => {
        await layout(state, page, false, false);
        for (
          const [selector, key, min, max, initial, direction] of [
            [".otk-inbox-resizer", "leftWidth", 200, 360, 248, 1],
            [".otk-panel-resizer", "rightWidth", 280, 480, 320, -1],
          ] as const
        ) {
          const handle = page.locator(selector);
          expect(
            await handle.evaluate((
              el,
            ) => [
              Number(el.getAttribute("aria-valuemin")),
              Number(el.getAttribute("aria-valuemax")),
            ]),
          ).toEqual([min, max]);
          for (
            const [press, expected] of [["Home", min], ["End", max]] as const
          ) {
            await handle.focus();
            await page.keyboard.press(press);
            await expect(handle).toHaveAttribute(
              "aria-valuenow",
              String(expected),
            );
            await expect.poll(async () =>
              (await state.product("prefs.get", {})).shellLayout[key]
            ).toBe(expected);
          }
          await state.product("layout.patch", { [key]: initial });
          await expect(handle).toHaveAttribute(
            "aria-valuenow",
            String(initial),
          );
          const rect = await handle.boundingBox();
          await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + 200);
          await page.mouse.down();
          await expect.poll(() =>
            handle.evaluate((el) => el.hasPointerCapture(1))
          ).toBe(true);
          await page.mouse.move(
            rect!.x + rect!.width / 2 + direction * 500,
            rect!.y + 200,
          );
          await page.mouse.up();
          await expect(handle).toHaveAttribute("aria-valuenow", String(max));
          await expect.poll(async () =>
            (await state.product("prefs.get", {})).shellLayout[key]
          ).toBe(max);
          await state.product("layout.patch", { [key]: initial });
        }
      });
      await test.step("2/corner-gestures-and-reload-once", async () => {
        await layout(state, page, true, true);
        await page.locator(".otk-corner-left").click();
        await page.locator(".otk-corner-right").click();
        await expect(page.locator(".otk-right-panel")).toBeVisible();
        await page.reload();
        await expect(page.locator(".otk-session-crumb[aria-current]"))
          .toBeVisible();
        expect((await page.locator(".otk-task-strip").boundingBox())!.height)
          .toBe(52);
        for (const kind of ["project", "session"]) {
          const row = page.locator(`.otk-${kind}-row`).first();
          expect((await row.boundingBox())!.height).toBe(
            await cssLength(row, "--row-project"),
          );
        }
        await expect(
          page.locator(".otk-session-tree .otk-tree-own").first(),
        ).toHaveText(
          "",
        );
        await expect(page.locator(".otk-session-crumb[aria-current]"))
          .toHaveAttribute("title", `Explore callers · ${state.directory}`);
        const handle = page.locator(".otk-inbox-resizer"),
          r = await handle.boundingBox();
        await page.mouse.move(r!.x + r!.width / 2, r!.y + 200);
        await page.mouse.down();
        await page.mouse.move(r!.x + r!.width / 2 + 64, r!.y + 200);
        await page.mouse.up();
        await expect.poll(async () =>
          (await state.product("prefs.get", {})).shellLayout.leftWidth
        ).toBe(312);
        await page.reload();
        await expect.poll(() =>
          page.locator(".otk-project-inbox").evaluate((el) =>
            el.getBoundingClientRect().width
          )
        ).toBe(312);
        const hover = page.locator('[data-project$="/projects/atmosphera"]');
        await hover.hover();
        await expect.poll(() =>
          hover.locator(".otk-project-menu").evaluate((el) =>
            getComputedStyle(el).opacity
          )
        ).toBe("1");
        expect(
          await hover.evaluate((el) =>
            getComputedStyle(el, "::before").backgroundColor
          ),
        ).toBe("rgba(0, 0, 0, 0)");
      });
      await test.step("2/shared-selection-palette-picker", async () => {
        for (const theme of manifest.themes) {
          await test.step(theme.id, async () => {
            await paint(theme);
            await page.locator(".otk-inbox-search").click();
            await page.locator("input[name=command-search]").fill(
              "Choose theme",
            );
            await expect(page.locator(".otk-palette-list button")).toHaveCount(
              1,
            );
            expect(
              await page.locator(".otk-palette-list .is-selected").evaluate((
                el,
              ) => getComputedStyle(el, "::before").width),
            ).toBe("3px");
            await page.keyboard.press("Enter");
            await expect(
              page.locator(
                `[data-theme-choice="${theme.id}"][aria-pressed=true]`,
              ),
            ).toBeVisible();
            expect(
              await page.locator("[data-theme-choice][aria-pressed=true]")
                .evaluate((el) => getComputedStyle(el, "::before").height),
            ).toBe("14px");
            await shot(`chrome-selection-${theme.id}-1280`);
            await page.keyboard.press("Escape");
            await tokens(page, theme);
          });
        }
      });
      await state.product("prefs.set", { key: "reducedColors", value: false });
      await test.step("3/rows-and-timeline", async () => {
        for (const theme of manifest.themes) {
          await test.step(theme.id, async () => {
            await paint(theme);
            await layout(state, page, false, false);
            await centers(
              page,
              ".otk-session-row",
              ".otk-status-light",
              ".otk-session-title",
            );
            for (const width of [280, 480]) {
              await state.product("layout.patch", { rightWidth: width });
              await expect.poll(() =>
                page.locator(".otk-right-panel").evaluate((el) =>
                  el.getBoundingClientRect().width
                )
              ).toBe(width);
              await centers(
                page,
                ".otk-session-row",
                ".otk-sidebar-lamp",
                ".otk-sidebar-label",
              );
              await centers(
                page,
                ".otk-session-row",
                ".otk-sidebar-lamp",
                ".otk-sidebar-meta",
              );
              expect(
                await page.locator(".otk-session-row .otk-session-title")
                  .evaluateAll((els) =>
                    els.every((el) =>
                      getComputedStyle(el).whiteSpace === "nowrap"
                    )
                  ),
              ).toBe(true);
              const gaps = await page.locator(".otk-panel-new-session")
                .evaluate((el) => {
                  const a = el.getBoundingClientRect(),
                    b = el.querySelector("svg")!.getBoundingClientRect();
                  return [
                    b.left - a.left,
                    a.right - b.right,
                    b.top - a.top,
                    a.bottom - b.bottom,
                  ];
                });
              expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(
                1,
              );
            }
            await state.product("layout.patch", { rightWidth: 320 });
            for (
              const [origin, selector] of [
                ["tab", '[data-tab="tstv1-working"]'],
                ["chip", '[data-crumb="tstv1-otk"]'],
                ["row", '[data-session="tstv1-otk"]'],
              ]
            ) {
              await page.locator(selector).click({ button: "right" });
              await page.locator(
                ':popover-open [data-context-command="session.rename"]',
              ).click();
              await expect(page.locator(".otk-title-editor")).toHaveCount(1);
              await expect(page.locator(".otk-title-editor")).toHaveAttribute(
                "data-origin",
                origin,
              );
              expect(
                await page.locator(".otk-title-editor input").evaluate((el) => {
                  const input = el as HTMLInputElement;
                  return document.activeElement === input &&
                    input.selectionStart === 0 &&
                    input.selectionEnd === input.value.length;
                }),
              ).toBe(true);
              await shot(`rename-${origin}-${theme.id}-1280`);
              await page.keyboard.press("Escape");
            }
            await page.locator('[data-session="tstv1-visual-1"]').click({
              button: "right",
            });
            await page.locator(
              ':popover-open [data-context-command="session.rename"]',
            ).click();
            await page.getByRole("textbox", {
              name: "Rename session",
              exact: true,
            }).fill("Retained editor");
            await page.keyboard.press("Enter");
            await expect(page.locator(".otk-sidebar-row-feedback [role=alert]"))
              .toBeVisible();
            await centers(
              page,
              ".otk-session-row.is-editing",
              "input",
              ".otk-status-light",
            );
            await centers(
              page,
              ".otk-session-row.is-editing",
              "input",
              ".otk-sidebar-meta",
            );
            expect(
              await page.locator(".otk-project-session-tree").evaluate((el) =>
                el.scrollWidth <= el.clientWidth
              ),
            ).toBe(true);
            await shot(`row-editing-${theme.id}-1280`);
            await page.keyboard.press("Escape");
            await centers(
              page,
              ".otk-project-row:has(time)",
              ".otk-status-light",
              ".otk-project-name-line",
            );
            await centers(
              page,
              ".otk-project-row:has(time)",
              ".otk-status-light",
              "time",
            );
            const row = page.locator('[data-project$="/projects/otk"]'),
              menu = row.locator(".otk-project-menu");
            const geometry = () =>
              row.evaluate((row) => {
                const cell = row.querySelector(".otk-project-trailing")!,
                  time = cell.querySelector("time")!,
                  trigger = cell.querySelector(".otk-popover-trigger")!,
                  r = cell.getBoundingClientRect(),
                  t = time.getBoundingClientRect(),
                  m = trigger.getBoundingClientRect();
                return {
                  box: [r.x, r.y, r.width, r.height],
                  centre: Math.max(
                    Math.abs(t.y + t.height / 2 - m.y - m.height / 2),
                    Math.abs(m.y + m.height / 2 - r.y - r.height / 2),
                  ),
                  positions: [
                    row,
                    cell,
                    time,
                    trigger,
                    ...Array.from(cell.children),
                  ].map((
                    el,
                  ) => getComputedStyle(el).position),
                  inside: t.left >= r.left && t.right <= r.right &&
                    m.left >= r.left && m.right <= r.right,
                };
              });
            await page.mouse.move(600, 500);
            await page.locator("body").evaluate(() =>
              (document.activeElement as HTMLElement)?.blur()
            );
            await expect.poll(() =>
              menu.evaluate((el) => getComputedStyle(el).opacity)
            ).toBe("0");
            const before = await geometry();
            expect(before.centre).toBeLessThanOrEqual(.5);
            expect(before.inside).toBe(true);
            expect(before.positions.every((p) => p === "static")).toBe(true);
            await row.hover();
            await expect.poll(() =>
              menu.evaluate((el) => getComputedStyle(el).opacity)
            ).toBe("1");
            await expect.poll(() =>
              row.locator(".otk-project-visit").evaluate((el) =>
                getComputedStyle(el).opacity
              )
            ).toBe("0");
            await expect(row.locator(".otk-project-visit")).toHaveCSS(
              "visibility",
              "hidden",
            );
            expect(await geometry()).toEqual(before);
            await page.mouse.move(600, 500);
            await row.locator(".otk-project-open").focus();
            await expect.poll(() =>
              menu.evaluate((el) => getComputedStyle(el).opacity)
            ).toBe("1");
            expect(await geometry()).toEqual(before);
            await page.goto(state.url + "/#/local/tstv1-otk");
            await layout(state, page, false, false);
            const sessionHeight = await page.locator(
              '[data-session="tstv1-otk"]',
            ).evaluate((el) => el.getBoundingClientRect().height);
            await page.locator("[data-panel-view=timeline]").click();
            await expect(page.locator("[data-timeline-prompt]")).toHaveCount(3);
            const first = page.locator('[data-timeline-prompt="prompt-0"]');
            expect(
              await first.evaluate((el) => {
                const r = el.getBoundingClientRect(),
                  t = el.querySelector(".otk-timeline-preview")!
                    .getBoundingClientRect();
                return { gutter: t.left - r.left, height: r.height };
              }),
            ).toEqual({
              // Timeline is flat: keep row padding without the session tree slots.
              gutter: await cssLength(first, "--space-2"),
              height: sessionHeight,
            });
            const actions = () =>
              first.locator("[data-message-command]").evaluateAll((els) =>
                els.map((el) => {
                  const r = el.getBoundingClientRect();
                  return [r.x, r.y, r.width, r.height];
                })
              );
            await page.mouse.move(0, 0);
            await page.locator("body").evaluate(() =>
              (document.activeElement as HTMLElement)?.blur()
            );
            await expect(first.locator("time")).toHaveCSS(
              "visibility",
              "visible",
            );
            const fixed = await actions();
            await first.locator(".otk-timeline-reveal").hover();
            await expect(first.locator("time")).toHaveCSS(
              "visibility",
              "visible",
            );
            expect(await actions()).toEqual(fixed);
            await expect(first.locator(".otk-timeline-reveal")).toHaveCSS(
              "background-color",
              "rgba(0, 0, 0, 0)",
            );
            await page.mouse.move(0, 0);
            await expect(first.locator("time")).toHaveCSS(
              "visibility",
              "visible",
            );
            expect(await actions()).toEqual(fixed);
            await first.locator(".otk-timeline-reveal").focus();
            await expect(first.locator("time")).toHaveCSS(
              "visibility",
              "visible",
            );
            expect(await actions()).toEqual(fixed);
            await centers(
              page,
              "[data-timeline-prompt]",
              ".otk-timeline-preview",
              "time",
            );
            await shot(`timeline-${theme.id}-1280`);
            await state.controller.call("scenario", {
              lease: state.lease.lease,
              action: "hold",
              sessionID: "tstv1-crumb-path",
            });
            await state.product("layout.patch", { rightView: "sessions" });
            await layout(state, page, true, true);
            for (const zoom of [1, 2]) {
              for (const physical of [600, 800, 1280, 1920]) {
                await test.step(`crumbs/${physical}@${zoom}`, async () => {
                  await cdp.send("Emulation.setDeviceMetricsOverride", {
                    width: physical / zoom,
                    height: 800 / zoom,
                    deviceScaleFactor: zoom,
                    mobile: false,
                  });
                  await settled(page);
                  const crumbRow = page.locator(".otk-breadcrumb-row");
                  const g = await crumbRow.evaluate(
                    (row) => {
                      const r = row.getBoundingClientRect(),
                        chips = Array.from(
                          row.querySelectorAll<HTMLElement>("[data-crumb]"),
                        ).filter((el) =>
                          el.getBoundingClientRect().width &&
                          getComputedStyle(el).visibility !== "hidden"
                        ),
                        meter = row.querySelector("output")!
                          .getBoundingClientRect(),
                        lane = row.querySelector(".otk-overflow-items")!,
                        items = lane.getBoundingClientRect(),
                        action = document.querySelector(".otk-new-session")!
                          .getBoundingClientRect();
                      return {
                        height: r.height,
                        controlsHeight: items.height,
                        paged: lane.closest(".otk-overflow-row")!.classList
                          .contains("is-paged"),
                        trackBelowControls: r.bottom - items.bottom,
                        centres: chips.map((el) => {
                          const b = el.getBoundingClientRect();
                          return b.y + b.height / 2;
                        }),
                        selected: chips.some((el) =>
                          el.dataset.crumb === "tstv1-otk"
                        ),
                        menus:
                          row.querySelectorAll(".otk-folded-crumbs").length,
                        bounds: items.right <= meter.left + 1 &&
                          items.right <= action.left + 1 &&
                          chips.every((el) => {
                            const b = el.getBoundingClientRect(),
                              label = el.querySelector(".otk-crumb-title")!,
                              first = el.querySelector(".otk-trail-first")
                                ?.getBoundingClientRect(),
                              range = document.createRange();
                            range.selectNodeContents(label);
                            // D67 retains every ancestor in its clipped scroll
                            // lane; each frame keeps its whole first word.
                            return (!first ||
                              first.left >= b.left - 1 &&
                                first.right <= b.right + 1) &&
                              range.getBoundingClientRect().height <=
                                parseFloat(getComputedStyle(label).lineHeight) +
                                  1;
                          }),
                      };
                    },
                  );
                  // D67's paged trail keeps the same single control line and
                  // reserves a separate, in-flow horizontal scroll track.
                  expect(g.controlsHeight).toBeLessThanOrEqual(32);
                  if (g.paged) {
                    const [track, gap] = await Promise.all([
                      cssLength(crumbRow, "--space-2"),
                      cssLength(crumbRow, "--space-1"),
                    ]);
                    expect(g.trackBelowControls).toBe(track + gap);
                    expect(g.height).toBeLessThanOrEqual(32 + track + gap);
                  } else {
                    expect(g.height).toBeLessThanOrEqual(32);
                  }
                  expect(g.selected && g.bounds).toBe(true);
                  expect(Math.max(...g.centres) - Math.min(...g.centres))
                    .toBeLessThanOrEqual(1);
                  expect(g.menus).toBe(0);
                  await shot(`breadcrumbs-${theme.id}-${physical}-zoom${zoom}`);
                });
              }
            }
            await restoreViewport(page, cdp);
            await page.setViewportSize({ width: 1280, height: 900 });
            await page.setViewportSize({ width: 800, height: 800 });
            await settled(page);
            await page.getByRole("button", { name: /^Subagents:/ }).click();
            const inventoryRows = page.locator(
              ".otk-subagents .otk-subagent-row[data-subagent]",
            );
            await expect(
              inventoryRows.first(),
            ).toBeVisible();
            const shown = await page.locator("[data-crumb]").evaluateAll((
              els,
            ) =>
              els.filter((el) => !el.closest("[hidden]")).map((el) =>
                el.getAttribute("data-crumb")!
              )
            );
            const omitted = await inventoryRows.evaluateAll((els) =>
              els.map((el) => el.getAttribute("data-subagent")!)
            );
            assertCrumbCoverage(
              ids,
              shown,
              omitted.sort(),
              // D67 checks coverage here, not ancestry order in a menu that
              // groups sessions by disposition. A duplicate still fails.
              [...ids.slice(1), "tstv1-child"].sort(),
            );
            await shot(`more-${theme.id}-800`);
            await page.keyboard.press("Escape");
            await state.controller.call("scenario", {
              lease: state.lease.lease,
              action: "release",
              sessionID: "tstv1-crumb-path",
            });
            await page.setViewportSize({ width: 1280, height: 900 });
          });
        }
      });
      await test.step("2/public-input-owned-chrome", async () => {
        await page.goto(
          facts.scenes + "/styles/?scene=chrome&server=" +
            encodeURIComponent(state.url),
        );
        await expect(page.locator("html")).toHaveAttribute(
          "data-ready",
          "true",
        );
        for (const theme of manifest.themes) {
          await test.step(theme.id, async () => {
            await paint(theme);
            await page.evaluate(
              "styleTest.reserve(false);styleTest.collapse(false)",
            );
            const width = async () =>
              (await page.locator(".otk-task-list").boundingBox())!.width;
            const normal = await width();
            await page.evaluate(
              "document.body.className='otk-app';document.body.dataset.rightCollapsed='true'",
            );
            expect(await width()).toBe(normal);
            await page.evaluate(
              "document.body.className='';styleTest.reserve(true)",
            );
            await expect(page.getByRole("button", { name: "Trailing action" }))
              .toBeVisible();
            await expect.poll(width).toBeLessThan(normal);
            await page.evaluate("styleTest.collapse(true)");
            await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
              "data-collapsed",
              "true",
            );
            // ConnectionBadge omits its label in the compact rail; the
            // remaining span is ControlIcon's visible lamp slot.
            await expect(page.locator(".otk-server-status .otk-server-label"))
              .toHaveCount(0);
            expect(
              (await page.locator(".otk-server-status [role=img]")
                .boundingBox())!.width,
            ).toBeGreaterThan(0);
            await expect(
              page.getByRole("button", { name: "Slot control", exact: true }),
            ).toHaveClass(/consumer-trigger/);
            await shot(`public-chrome-${theme.id}-1280`);
          });
        }
      });
      await test.step("3/public-editing-and-more", async () => {
        await page.goto(
          facts.scenes + "/styles/?scene=lists&server=" +
            encodeURIComponent(state.url),
        );
        await expect(page.locator("html")).toHaveAttribute(
          "data-ready",
          "true",
        );
        const members = facts.lists.entries.map(({ id }) => id);
        for (const theme of manifest.themes) {
          await test.step(theme.id, async () => {
            await paint(theme);
            await page.setViewportSize({ width: 600, height: 800 });
            await page.evaluate(
              `styleTest.lists(...${
                JSON.stringify([
                  members,
                  members[9],
                  members[7],
                  facts.lists,
                ])
              })`,
            );
            const edit = page.locator(`[data-crumb="${members[7]}"] input`);
            await expect(edit).toHaveValue("session-7");
            await expect(edit).toBeFocused();
            const visible = () =>
              page.locator("[data-crumb]").evaluateAll((els) =>
                els.filter((el) => !el.closest("[hidden]")).map((el) =>
                  el.getAttribute("data-crumb")!
                )
              );
            const shown = await visible();
            expect(shown).toContain(members[9]);
            expect(shown).toContain(members[7]);
            expect(shown).toEqual(members);
            expect(
              await edit.evaluate((el) => {
                const a = el.getBoundingClientRect(),
                  b = el.closest(".otk-overflow-row")!.getBoundingClientRect();
                return a.width > 0 && a.left >= b.left && a.right <= b.right;
              }),
            ).toBe(true);
            await shot(`editing-${theme.id}-600`);
            // D67 moved Subagents out of the trail. Keep the editor-blur
            // press proof on its same-row Session action, then test the menu.
            const sessionAction = page.locator(".otk-new-session"),
              actionBefore = await sessionAction.boundingBox(),
              createdBefore = await page.evaluate(
                "styleTest.createdSessions()",
              );
            await sessionAction.click();
            await expect.poll(() =>
              page.evaluate("styleTest.createdSessions()")
            )
              .toBe(Number(createdBefore) + 1);
            const actionAfter = await sessionAction.boundingBox();
            for (const key of ["x", "y", "width", "height"] as const) {
              expect(Math.abs(actionAfter![key] - actionBefore![key]))
                .toBeLessThanOrEqual(1);
            }
            const more = page.getByRole("button", { name: /^Subagents:/ }),
              before = await more.boundingBox();
            await more.click();
            await expect(
              page.locator(".otk-subagents [role=menuitem]").first(),
            ).toBeVisible();
            const after = await more.boundingBox();
            for (const key of ["x", "y", "width", "height"] as const) {
              expect(Math.abs(after![key] - before![key])).toBeLessThanOrEqual(
                1,
              );
            }
            const omitted = await page.locator(
              ".otk-subagents .otk-subagent-row[data-subagent]",
            )
              .evaluateAll((els) =>
                els.map((el) => el.getAttribute("data-subagent")!)
              );
            expect(await visible()).toEqual(members);
            expect(omitted).toEqual(members.slice(1));
            expect(
              await page.locator("[data-subagent]").evaluateAll((els) =>
                els.every((el) => !el.closest("[data-overflow-key]"))
              ),
            ).toBe(true);
            await shot(`editing-more-${theme.id}-600`);
            await page.keyboard.press("Escape");
          });
        }
      });
      await test.step("3/task-scrolling-strip", async () => {
        const corpus = await state.controller.call<
          { ids: string[]; tasks: string[] }
        >("scenario", {
          lease: state.lease.lease,
          action: "hold",
          target: "tabs-pin",
        }, 120_000);
        await page.goto(state.url + "/#/local/" + corpus.ids[0]);
        await layout(state, page, true, true);
        const geometry = () => stripGeometry(page);
        for (const theme of manifest.themes) {
          await test.step("idle/" + theme.id, async () => {
            await paint(theme);
            for (const width of [600, 800, 1280, 1920]) {
              await test.step(String(width), async () => {
                await page.setViewportSize({ width, height: 900 });
                await settled(page);
                const g = await geometry();
                expect(Math.abs(g.height - g.expected)).toBeLessThanOrEqual(1);
                expect(g.tabs).toHaveLength(300);
                expect(Math.min(...g.tabs.map((tab) => tab.width)))
                  .toBeGreaterThanOrEqual(90);
                expect(g.total).toBeGreaterThan(g.width);
                expect(g.previous).toBe(g.left > 1);
                expect(g.next).toBe(g.left + g.width < g.total - 1);
                for (const gaps of g.gaps) {
                  expect(Math.max(...gaps) - Math.min(...gaps))
                    .toBeLessThanOrEqual(1);
                }
                await expect(
                  page.locator(
                    ".otk-task-list .otk-overflow-more,.otk-auto-mark",
                  ),
                )
                  .toHaveCount(0);
                await shot(`task-idle-${theme.id}-${width}`);
              });
            }
          });
        }
        await state.controller.call("scenario", {
          lease: state.lease.lease,
          action: "release",
          target: "tabs-pin",
        });
        await page.goto(state.url + "/#/local/" + corpus.ids[250]);
        await layout(state, page, true, true);
        await page.setViewportSize({ width: 800, height: 900 });
        for (const theme of manifest.themes) {
          await test.step("required/" + theme.id, async () => {
            await paint(theme);
            await settled(page);
            const g = await geometry();
            expect(g.height).toBe(g.expected);
            expect(g.full).toContain(corpus.tasks[250]);
            // Activity never reorders task identities. The scrolling strip
            // retains every task in its saved/source order while revealing
            // the selected task through its ordinary scroll owner.
            expect(g.tabs.map((tab) => tab.id)).toEqual(corpus.tasks);
            await shot(`task-required-${theme.id}-800`);
          });
        }
      });
      await collections456({
        state,
        page,
        cdp,
        themes: manifest.themes,
        native: facts.native,
        content: facts.content,
        scenes: facts.scenes,
        traffic,
        paint,
        shot,
      });
      await collections789({
        state,
        page,
        cdp,
        themes: manifest.themes,
        content: facts.content,
        scenes: facts.scenes,
        paint,
        shot,
      });
      await remainder({
        state,
        page,
        themes: manifest.themes,
        scenes: facts.scenes,
        content: facts.content,
        paint,
        shot,
      });
      await supplemental({
        state,
        page,
        cdp,
        themes: manifest.themes,
        scenes: facts.scenes,
        paint,
        shot,
      });
      await nativeStates({
        state,
        page,
        themes: manifest.themes,
        native: facts.native,
        paint,
        shot,
      });
      const ledger = JSON.parse(
        await readFile(new URL("../migration.json", import.meta.url), "utf8"),
      );
      const owned = ledger.files.flatMap((
        file: { groups: { id: string; activeOwner: { file: string } }[] },
      ) =>
        file.groups.filter((group) =>
          group.activeOwner.file === "tests/browser/themes/sweep.spec.ts"
        ).map((group) => group.id)
      ).sort();
      expect(checked.assertions.map((a: { legacy: string }) => a.legacy).sort())
        .toEqual(owned);
      expect(
        checked.supplementalAssertions.map((a: { id: string }) => a.id).sort(),
      ).toEqual(
        ledger.supplementalTransfers.filter((
          a: { themeWitness?: { id: string } },
        ) => a.themeWitness).map((a: { themeWitness: { id: string } }) =>
          a.themeWitness.id
        ).sort(),
      );
      const proofMap: Record<string, string[]> = {};
      // Check fixed-state evidence independently of historical assertion groups.
      for (
        const id of [
          "usage",
          "money",
          "dialogs",
          "menus",
          "lights",
          "automatic",
          "all-selection",
          "forms",
          "preference-feedback",
          "menu-feedback",
          "dialog-lifetimes",
          "project-error",
          "type-scale",
          "timestamps",
          "window-bubble",
          "native-controls",
          "checkboxes",
          "labels",
        ]
      ) {
        for (const template of checked.variants[id] as string[]) {
          let names = [template];
          for (
            const [key, values] of Object.entries({
              theme: manifest.themes.map((t) => t.id),
              viewport: [600, 800, 1280, 1920],
              zoom: [1, 2],
              reduced: [false, true],
            })
          ) {
            names = names.flatMap((name) =>
              name.includes(`{${key}}`)
                ? values.map((value) =>
                  name.replaceAll(`{${key}}`, String(value))
                )
                : [name]
            );
          }
          for (const name of names) {
            expect(witnessed.has(name), id + ": " + name).toBe(true);
          }
        }
      }
      for (
        const assertion of [
          ...checked.assertions,
          ...checked.supplementalAssertions.map((
            a: { id: string; state: string },
          ) => ({ legacy: a.id, state: a.state })),
        ]
      ) {
        const variants = checked.variants[assertion.state] as string[];
        expect(variants, assertion.legacy).toBeTruthy();
        const names: string[] = [];
        for (const template of variants) {
          for (const theme of manifest.themes) {
            for (
              const viewport of template.includes("{viewport}")
                ? [600, 800, 1280, 1920]
                : [1280]
            ) {
              for (const zoom of template.includes("{zoom}") ? [1, 2] : [1]) {
                for (
                  const reduced of template.includes("{reduced}")
                    ? [false, true]
                    : [false]
                ) {
                  const name = template.replaceAll("{theme}", theme.id)
                    .replaceAll("{viewport}", String(viewport)).replaceAll(
                      "{zoom}",
                      String(zoom),
                    ).replaceAll("{reduced}", String(reduced));
                  expect(witnessed.has(name), assertion.legacy + ": " + name)
                    .toBe(true);
                  names.push(name);
                }
              }
            }
          }
        }
        proofMap[assertion.legacy] = names;
      }
      await info.attach("checked-state-manifest", {
        body: JSON.stringify({
          ...checked,
          witnessed: [...witnessed],
          proofMap,
          registeredThemes: manifest,
        }),
        contentType: "application/json",
      });
      expect(task.id).toBeTruthy();
    } finally {
      await cdp.detach();
    }
  },
);
