// SPDX-License-Identifier: LGPL-3.0-only
import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import { accessoryGeometry } from "../../support/control-geometry.ts";
import { selectionGeometry } from "../../support/selection-geometry.ts";
import { fixedContent } from "./content.ts";
import { reveal } from "./collections.ts";
import { restoreViewport } from "./capture.ts";

interface Inputs {
  state: TestState;
  page: Page;
  cdp: CDPSession;
  themes: { id: string }[];
  content: { sessionID: string };
  scenes: string;
  paint(theme: { id: string }): Promise<void>;
  shot(name: string): Promise<void>;
}
async function frames(page: Page) {
  await page.evaluate(() =>
    document.fonts.ready.then(() =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    )
  );
}
async function close(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open],:popover-open")).toHaveCount(0);
}
async function command(page: Page, id: string, query: string) {
  await page.keyboard.press("Control+k");
  await page.locator("input[name=command-search]").fill(query);
  await page.locator(`[data-command="${id}"]`).click();
}
async function surface(page: Page) {
  const owner = page.locator(
    "dialog[open] .otk-surface,:popover-open .otk-surface",
  );
  await expect(owner).toHaveCount(1);
  await frames(page);
  const failures = await owner.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      css = getComputedStyle(el),
      errors: string[] = [];
    const box = {
      left: r.left + parseFloat(css.borderLeftWidth) +
        parseFloat(css.paddingLeft),
      right: r.right - parseFloat(css.borderRightWidth) -
        parseFloat(css.paddingRight),
      top: r.top + parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop),
      bottom: r.bottom - parseFloat(css.borderBottomWidth) -
        parseFloat(css.paddingBottom),
    };
    for (
      const child of [
        ...Array.from(el.children),
        ...Array.from(el.querySelectorAll(":scope > * > *")),
      ]
    ) {
      const b = child.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (
        b.left < box.left - .5 || b.right > box.right + .5 ||
        b.top < box.top - .5 || b.bottom > box.bottom + .5
      ) errors.push(child.outerHTML.slice(0, 160));
    }
    const dialog = el.closest("dialog");
    if (dialog && dialog.querySelectorAll("h1,h2,h3,h4,h5,h6").length !== 1) {
      errors.push("heading ownership");
    }
    const focused = document.activeElement;
    if (focused?.matches(":focus-visible") && el.contains(focused)) {
      const clip = focused.closest(".otk-surface-body");
      if (clip) {
        const b = focused.getBoundingClientRect(),
          c = clip.getBoundingClientRect(),
          s = getComputedStyle(focused),
          ring = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset);
        if (
          b.left - ring < c.left - .5 || b.right + ring > c.right + .5 ||
          b.top - ring < c.top - .5 || b.bottom + ring > c.bottom + .5
        ) errors.push("clipped focus");
      }
    }
    return errors;
  });
  expect(failures).toEqual([]);
}
async function positioned(page: Page, anchor?: string) {
  await frames(page);
  const g = await page.locator(":popover-open .otk-surface").evaluate(
    (el, anchor) => {
      const r = el.getBoundingClientRect(),
        p = el.closest(".otk-popover-panel")!.getBoundingClientRect(),
        body = el.querySelector(".otk-surface-body")!,
        clip = body.getBoundingClientRect(),
        a = anchor
          ? document.querySelector(anchor)!.getBoundingClientRect()
          : null;
      return {
        width: r.width,
        height: r.height,
        inside: r.left >= -.5 && r.top >= -.5 && r.right <= innerWidth + .5 &&
          r.bottom <= innerHeight + .5,
        edges: [
          r.left - p.left,
          r.right - p.right,
          r.top - p.top,
          r.bottom - p.bottom,
        ],
        separate: !a || r.bottom <= a.top + .5 || r.top >= a.bottom - .5 ||
          r.right <= a.left + .5 || r.left >= a.right - .5,
        scroll: body.scrollHeight,
        body: body.clientHeight,
        rows: Array.from(el.querySelectorAll("[role=menuitem]")).map((row) => {
          const b = row.getBoundingClientRect(),
            hit = document.elementFromPoint(
              b.x + b.width / 2,
              b.y + b.height / 2,
            );
          return b.width > 0 && b.height > 0 && b.left >= r.left &&
            b.right <= r.right && b.top >= clip.top &&
            b.bottom <= clip.bottom && !!hit && row.contains(hit);
        }),
      };
    },
    anchor,
  );
  expect(g.width).toBeGreaterThan(0);
  expect(g.height).toBeGreaterThan(0);
  expect(g.inside && g.separate).toBe(true);
  g.edges.forEach((d) => expect(Math.abs(d)).toBeLessThanOrEqual(.5));
  return g;
}
export async function menuGeometry(page: Page) {
  const g = await page.locator(":popover-open [role=menu]").evaluate((menu) => {
    const panel = menu.closest(".otk-surface")!,
      r = panel.getBoundingClientRect(),
      first = menu.parentElement!.firstElementChild!.getBoundingClientRect(),
      last = menu.parentElement!.lastElementChild!.getBoundingClientRect();
    return {
      inside: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 &&
        r.right <= innerWidth + .5 && r.bottom <= innerHeight + .5,
      rows: Array.from(menu.querySelectorAll("button")).map((el) =>
        el.getBoundingClientRect().height
      ),
      balanced: Math.abs((first.top - r.top) - (r.bottom - last.bottom)) < .5,
    };
  });
  expect(g.inside && g.balanced).toBe(true);
  expect(g.rows.length).toBeGreaterThan(0);
  expect(g.rows).toEqual(g.rows.map(() => 28));
}
async function allMarks(
  cdp: CDPSession,
  selector: string,
  minimum: number,
) {
  const items = await selectionGeometry({
    send: (method, params = {}) =>
      cdp.send(method as Parameters<CDPSession["send"]>[0], params),
  }, selector);
  expect(items.length).toBeGreaterThanOrEqual(minimum);
  for (const item of items) {
    expect(item.shift).toBe(0);
    expect(item.position).toBe("static");
    if (item.orientation === "vertical") {
      expect([item.w, item.h, item.start]).toEqual([3, 14, 3]);
      expect(item.centred).toBeLessThanOrEqual(.5);
    } else {expect([item.h, item.start, item.end, item.bottom]).toEqual([
        2,
        8,
        8,
        0,
      ]);}
    expect(item.paint === "rgba(0, 0, 0, 0)").toBe(!item.selected);
    if (item.ariaSelected !== null) {
      expect(item.ariaSelected === "true").toBe(item.selected);
    }
    if (item.ariaPressed !== null) {
      expect(item.ariaPressed === "true").toBe(item.selected);
    }
    if (item.ariaCurrent !== null) expect(item.ariaCurrent).toBe("page");
  }
}
export async function usage(
  { state, page, cdp, themes, content, paint, shot }: Inputs,
) {
  const prefs = async (
    key: "showCost" | "reducedColors" | "animationsOff",
    value: boolean,
  ) => {
    await state.product("prefs.set", { key, value });
  };
  const contentState = async (name: string) => {
    await fixedContent(state, page, content.sessionID, name);
    await expect(page.locator(".otk-turn-usage > button")).toBeVisible();
  };
  await test.step("7/usage-fixed-values-and-scroll", async () => {
    for (
      const [name, count] of [["small", 3], ["long", 120], ["unknown", 1], [
        "unreported",
        1,
      ], [
        "queued",
        2,
      ]] as const
    ) {
      await contentState("usage-" + name);
      for (const theme of themes) {
        // Own this fixed geometry input: earlier task groups and narrow usage
        // captures must not virtualize one of the three charged witness rows.
        await page.setViewportSize({ width: 1280, height: 1000 });
        await paint(theme);
        await state.product("layout.patch", {
          rightCollapsed: false,
          rightView: "sessions",
        });
        for (const width of [320, 280]) {
          await state.product("layout.patch", { rightWidth: width });
          await state.product("prefs.set", { key: "showCost", value: true });
          await expect(page.locator(".otk-session-cost")).toHaveCount(
            name === "unknown" || name === "unreported" ? 2 : 3,
          );
          const boxes = await page.locator(
            ".otk-session-row:has(.otk-session-cost)",
          ).evaluateAll((rows) =>
            rows.map((row) => {
              const c = row.querySelector(".otk-session-cost")!
                  .getBoundingClientRect(),
                t = row.querySelector(".otk-row-title")!
                  .getBoundingClientRect(),
                l = row.querySelector(".otk-status-light")!
                  .getBoundingClientRect();
              return {
                right: c.right,
                centre: c.y + c.height / 2,
                title: t.y + t.height / 2,
                light: l.y + l.height / 2,
                height: row.getBoundingClientRect().height,
                overflow: row.scrollWidth > row.clientWidth,
              };
            })
          );
          for (const box of boxes) {
            expect(Math.abs(box.right - boxes[0].right)).toBeLessThanOrEqual(
              .5,
            );
            expect(Math.abs(box.centre - box.title)).toBeLessThanOrEqual(.5);
            expect(Math.abs(box.centre - box.light)).toBeLessThanOrEqual(.5);
            expect(box.height).toBe(30);
            expect(box.overflow).toBe(false);
          }
          await shot(`usage-rows-${name}-${width}-${theme.id}`);
        }
        for (const cost of [true, false]) {
          await prefs("showCost", cost);
          for (const [width, height] of [[1280, 720], [800, 600]]) {
            await page.setViewportSize({ width, height });
            await page.locator("textarea[name=prompt]").click();
            const trigger = page.locator(".otk-turn-usage > button");
            await trigger.focus();
            await expect(page.locator(".otk-usage-breakdown tbody tr"))
              .toHaveCount(count);
            await expect.poll(() =>
              page.locator(".otk-usage-breakdown tbody tr").evaluateAll(
                (rows) => rows.map((r) => r.children.length),
              )
            ).toEqual(Array(count).fill(cost ? 10 : 9));
            if (!cost) {
              await expect(page.locator(".otk-usage-cost,.otk-session-cost"))
                .toHaveCount(0);
            }
            if (name === "unknown" || name === "unreported") {
              await expect(page.locator(".otk-usage-category-cost"))
                .toHaveCount(0);
            }
            if (name === "unreported") {
              await expect(trigger).toContainText("Tokens unavailable");
              if (cost) await expect(trigger).toContainText("Cost unavailable");
              await expect(page.locator(".otk-message-footer")).not
                .toContainText("$0.00");
            }
            const g = await page.locator(".otk-turn-usage :popover-open")
              .evaluate((el) => {
                const r = el.getBoundingClientRect(),
                  s = el.querySelector(".otk-usage-scroll")!;
                const edge = (e: Element) => {
                  const r = document.createRange();
                  r.selectNodeContents(e);
                  return r.getBoundingClientRect().right;
                };
                return {
                  inside: r.left >= 8 && r.top >= 8 &&
                    r.right <= innerWidth - 8 && r.bottom <= innerHeight - 8,
                  delta: Math.abs(
                    edge(el.querySelector("tbody .otk-usage-context > span")!) -
                      edge(el.querySelector("tfoot tr")!.children[1]),
                  ),
                  scroll: s.scrollHeight > s.clientHeight,
                };
              });
            expect(g.inside).toBe(true);
            expect(g.delta).toBeLessThanOrEqual(.5);
            if (name === "long") expect(g.scroll).toBe(true);
            if (name === "small" || name === "long") {
              expect(
                await page.locator(".otk-usage-activity span").first().evaluate(
                  (el) =>
                    el.scrollWidth > el.clientWidth &&
                    getComputedStyle(el).textOverflow === "ellipsis",
                ),
              ).toBe(true);
            }
            for (const position of ["initial", "middle", "end"]) {
              await page.locator(".otk-usage-scroll").evaluate(
                (el, position) => {
                  el.scrollTop = position === "initial"
                    ? 0
                    : position === "middle"
                    ? (el.scrollHeight - el.clientHeight) / 2
                    : el.scrollHeight;
                  el.scrollLeft = position === "end" ? el.scrollWidth : 0;
                },
                position,
              );
              await frames(page);
              expect(
                await page.locator(".otk-usage-scroll").evaluate(
                  (el, position) => {
                    const r = el.getBoundingClientRect();
                    return [
                      "thead th",
                      "tfoot th",
                      ...(position === "end" ? ["tbody tr:last-child"] : []),
                    ].every((q) => {
                      const b = el.querySelector(q)!.getBoundingClientRect();
                      return b.top >= r.top && b.bottom <= r.bottom;
                    });
                  },
                  position,
                ),
              ).toBe(true);
              await shot(
                `usage-${name}-${cost}-${width}-${position}-${theme.id}`,
              );
            }
            await page.keyboard.press("Escape");
            await page.keyboard.press("Tab");
          }
        }
      }
    }
    await prefs("showCost", true);
    for (
      const [i, label, exact] of [
        [0, "$0.00", "$0"],
        [1, "<$0.01", "$0.00000005"],
        [2, "<$0.01", "$0.0096"],
        [3, "$0.01", "$0.01"],
        [4, "$1.20", "$1.2"],
        [5, "$1,234.57", "$1,234.567"],
      ] as const
    ) {
      await contentState("usage-money-" + i);
      for (const theme of themes) {
        await paint(theme);
        await state.product("layout.patch", {
          rightCollapsed: false,
          rightView: "sessions",
        });
        await expect(
          page.locator(
            `[data-session="${content.sessionID}"] .otk-session-cost`,
          ),
        ).toHaveText(label);
        await expect(page.locator(".otk-context-meter .otk-usage-cost"))
          .toHaveText(label);
        await expect(page.locator(`[data-session="${content.sessionID}"]`))
          .toHaveAttribute("aria-description", `Exact session cost: ${exact}`);
        await expect(page.locator(".otk-turn-usage > button")).toHaveAttribute(
          "aria-label",
          `Turn usage: 1 model call \u00b7 100 tokens \u00b7 ${label}; exact cost ${exact}`,
        );
        await page.locator(".otk-turn-usage > button").focus();
        await expect(page.locator(".otk-usage-breakdown tbody tr")).toHaveCount(
          1,
        );
        await expect(
          page.locator(
            "[data-usage-summary=cost] .otk-usage-cost,tbody .otk-usage-cost,tfoot tr > td:nth-last-child(2) .otk-usage-cost",
          ),
        ).toHaveText([label, label, label]);
        await expect(page.locator("tfoot .otk-usage-category-cost")).toHaveText(
          ["<$0.01", "$0.00", "$0.00", "$0.00", "$0.00"],
        );
        await expect(
          page.locator(
            ".otk-usage-cost[title],.otk-turn-usage > button[title]",
          ),
        ).toHaveCount(0);
        const tree = await cdp.send("Accessibility.getFullAXTree") as {
          nodes: {
            role?: { value: string };
            name?: { value: string };
            description?: { value: string };
          }[];
        };
        expect(
          tree.nodes.filter((n) =>
            n.role?.value === "group" && n.name?.value === label &&
            n.description?.value === `Exact cost: ${exact}`
          ),
        ).toHaveLength(i === 0 ? 8 : 4);
        expect(
          tree.nodes.some((n) =>
            n.role?.value === "button" &&
            n.description?.value === `Exact session cost: ${exact}`
          ),
        ).toBe(true);
        expect(
          tree.nodes.some((n) =>
            n.role?.value === "button" &&
            n.name?.value ===
              `Turn usage: 1 model call \u00b7 100 tokens \u00b7 ${label}; exact cost ${exact}`
          ),
        ).toBe(true);
        const category = await page.locator(
          "tfoot .otk-usage-category-cost .otk-usage-cost",
        ).first().getAttribute("aria-description");
        expect(Math.abs(Number(category!.split("$")[1]) - .0002))
          .toBeLessThanOrEqual(1e-12);
        await shot(`usage-money-${i}-${theme.id}`);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Tab");
      }
    }
  });
}
export async function surfaces(
  { state, page, cdp, themes, content, paint, shot }: Inputs,
) {
  const prefs = async (
    key: "showCost" | "reducedColors" | "animationsOff",
    value: boolean,
  ) => {
    await state.product("prefs.set", { key, value });
  };
  await page.setViewportSize({ width: 1280, height: 900 });
  await state.product("layout.patch", {
    leftCollapsed: false,
    rightCollapsed: false,
    rightView: "sessions",
  });
  await page.goto(state.url + "/#/local/tstv1-otk");
  await page.locator("textarea[name=prompt]").fill("Keep this prompt");
  await test.step("8/registered-surfaces", async () => {
    for (const theme of themes) {
      await paint(theme);
      for (const reduced of [false, true]) {
        await prefs("reducedColors", reduced);
        await allMarks(cdp, ".otk-project-inbox [data-otk-selection]", 4);
        await allMarks(cdp, ".otk-project-sessions [data-otk-selection]", 10);
        await allMarks(cdp, ".otk-project-tabs [data-otk-selection]", 3);
        await allMarks(cdp, ".otk-panel-icons [data-otk-selection]", 1);
        await page.setViewportSize({ width: 800, height: 900 });
        await page.locator(".otk-folded-crumbs > button").click();
        await surface(page);
        await menuGeometry(page);
        await allMarks(
          cdp,
          ".otk-folded-crumbs .otk-menu-items [data-otk-selection]",
          1,
        );
        await shot(`selection-more-${reduced}-${theme.id}`);
        await close(page);
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.keyboard.press("Control+k");
        await allMarks(cdp, ".otk-palette-list [data-otk-selection]", 5);
        await page.locator("input[name=command-search]").fill("Choose theme");
        await page.keyboard.press("Enter");
        await allMarks(cdp, "[data-theme-choice]", 4);
        await shot(`selection-${reduced}-${theme.id}`);
        await close(page);
      }
      await prefs("reducedColors", false);
      for (
        const [name, open] of [
          ["Display", async () => {
            await page.locator(".otk-display-menu > button").click();
          }],
          ["Commands", async () => {
            await page.keyboard.press("Control+k");
          }],
          ["Keyboard shortcuts", async () => {
            await page.locator(".otk-keys-entry").click();
          }],
          ["Theme", async () => {
            await command(page, "theme.open", "Choose theme");
          }],
          ["Display preferences", async () => {
            await command(page, "display.open", "Display preferences");
          }],
          ["Add project", async () => {
            await page.locator(".otk-add-project").click();
          }],
          ["New task", async () => {
            await page.locator(".otk-task-new").click();
          }],
          ["Editor", async () => {
            await page.getByRole("button", { name: "Edit prompt", exact: true })
              .click();
          }],
        ] as const
      ) {
        await open();
        await surface(page);
        if (name === "Keyboard shortcuts") {
          await expect(page.locator('[data-binding="prompt.submit"] kbd'))
            .toHaveText("Enter");
        }
        if (name === "Editor") {
          await expect(page.locator(".otk-editor p")).toHaveText(
            "Save to keep changes",
          );
          await expect(page.locator("dialog[open] .otk-surface-title button"))
            .toHaveText("Close");
        }
        if (name !== "Display") {
          if (name === "Editor" || name === "New task") {
            await expect(page.locator("dialog[open] .otk-surface-title kbd"))
              .toHaveCount(0);
          }
          for (
            const zoom of name === "Editor" || name === "New task"
              ? [1, 2]
              : [1]
          ) {
            for (
              const physical of name === "Editor" || name === "New task"
                ? [600, 800, 1280, 1920]
                : [1280]
            ) {
              await cdp.send("Emulation.setDeviceMetricsOverride", {
                width: physical / zoom,
                height: 1000 / zoom,
                deviceScaleFactor: zoom,
                mobile: false,
              });
              await frames(page);
              expect(
                await page.locator("dialog[open]").evaluate((el) => {
                  const r = el.getBoundingClientRect();
                  return r.left >= -1 && r.top >= -1 &&
                    r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
                }),
              ).toBe(true);
              if (name === "New task") {
                const g = await page.locator("input[name=taskName]").evaluate(
                  (el) => {
                    const r = el.getBoundingClientRect(),
                      form = el.closest("form")!,
                      f = form.getBoundingClientRect(),
                      body = form.closest(".otk-surface-body")!,
                      b = body.getBoundingClientRect(),
                      s = getComputedStyle(body),
                      button = form.querySelector("button[type=submit]")!,
                      p = getComputedStyle(button),
                      probe = document.createElement("span");
                    probe.style.color = "var(--otk-action-on)";
                    probe.style.background = "var(--otk-action)";
                    document.body.append(probe);
                    const expected = getComputedStyle(probe),
                      primary =
                        p.backgroundColor === expected.backgroundColor &&
                        p.color === expected.color;
                    probe.remove();
                    return {
                      delta: Math.max(
                        Math.abs(r.left - b.left - parseFloat(s.paddingLeft)),
                        Math.abs(
                          r.right - b.right + parseFloat(s.paddingRight),
                        ),
                        Math.abs(f.width - r.width),
                      ),
                      primary,
                      width:
                        el.closest("dialog")!.getBoundingClientRect().width,
                    };
                  },
                );
                expect(g.delta).toBeLessThanOrEqual(1);
                expect(g.primary).toBe(true);
                expect(g.width).toBeLessThanOrEqual(417);
              }
              if (name === "Editor") {
                const bounds = await page.locator("dialog[open]").evaluate(
                  (el) => {
                    const d = el.getBoundingClientRect(),
                      t = el.querySelector("textarea[name=editor]")!
                        .getBoundingClientRect(),
                      f = el.querySelector(".otk-editor footer")!
                        .getBoundingClientRect(),
                      g = parseFloat(
                        getComputedStyle(document.documentElement)
                          .getPropertyValue("--overlay-gutter"),
                      );
                    return [
                      d.left - g,
                      innerWidth - d.right - g,
                      d.top - g,
                      innerHeight - d.bottom - g,
                      f.top - t.bottom,
                      d.bottom - f.bottom,
                    ];
                  },
                );
                bounds.slice(0, 5).forEach((v) =>
                  expect(v).toBeGreaterThanOrEqual(-1)
                );
                expect(bounds[5]).toBeLessThan(24);
              }
              await shot(
                `dialog-${
                  name.replaceAll(" ", "-").toLowerCase()
                }-${physical}-zoom${zoom}-${theme.id}`,
              );
            }
          }
          await restoreViewport(page, cdp);
          await page.setViewportSize({ width: 1280, height: 900 });
        } else {
          const values = await page.evaluate(accessoryGeometry) as {
            gaps: number[];
          }[];
          expect(values.length).toBeGreaterThan(0);
          values.forEach((v) =>
            expect(Math.max(...v.gaps) - Math.min(...v.gaps))
              .toBeLessThanOrEqual(1)
          );
          await shot(`dialog-display-${theme.id}`);
        }
        await close(page);
        if (name === "New task") {
          await expect(page.locator(".otk-task-new")).toBeFocused();
        }
        if (name === "Editor") {
          await expect(
            page.getByRole("button", { name: "Edit prompt", exact: true }),
          ).toBeFocused();
        }
      }
      await page.locator(".otk-project-menu > button").first().click();
      await surface(page);
      await menuGeometry(page);
      await shot(`dialog-project-menu-${theme.id}`);
      await close(page);
      await page.locator(".otk-keys-entry").focus();
      await page.keyboard.press("ContextMenu");
      await positioned(page);
      await close(page);
      await page.locator("body").evaluate(() =>
        (document.activeElement as HTMLElement)?.blur()
      );
      await page.keyboard.press("ContextMenu");
      const body = await positioned(page);
      expect(body.rows.length).toBeGreaterThan(0);
      expect(body.rows.every(Boolean)).toBe(true);
      await shot(`menu-body-fallback-${theme.id}`);
      await close(page);
      await command(page, "display.open", "Display preferences");
      await page.locator("dialog input[name=showCost]").click({
        button: "right",
      });
      await menuGeometry(page);
      await shot(`menu-modal-${theme.id}`);
      await page.keyboard.press("Escape");
      await expect(page.locator(":popover-open")).toHaveCount(0);
      await close(page);
      for (
        const selector of [
          ".otk-inbox-scroll",
          ".otk-panel-content",
          ".otk-messages",
          ".otk-prompt-actions",
          '[data-project$="/projects/otk"] .otk-project-open',
          '[data-crumb="tstv1-otk"]',
          '[data-session="tstv1-otk"]',
          ".otk-user-bubble",
        ]
      ) {
        await page.locator(selector).first().click({ button: "right" });
        await menuGeometry(page);
        await shot(
          `context-${selector.replaceAll(/[^a-z0-9]/gi, "-")}-${theme.id}`,
        );
        await close(page);
      }
      await page.locator('[data-session="tstv1-visual-1"]').click({
        button: "right",
      });
      await page.locator(
        ':popover-open [data-context-command="session.delete"]',
      ).click();
      await expect(
        page.locator(':popover-open [data-context-command="session.delete"]'),
      ).toHaveText("Press again to delete");
      await expect(
        page.locator(':popover-open [data-context-command="session.delete"]'),
      ).toHaveClass(/is-armed/);
      await shot(`menu-delete-armed-${theme.id}`);
      await close(page);
      for (const [x, y] of [[1, 1], [1279, 1], [1, 899], [1279, 899]]) {
        await page.mouse.click(x, y, { button: "right" });
        const g = await positioned(page);
        expect(g.rows.length).toBeGreaterThan(0);
        expect(g.rows.every(Boolean)).toBe(true);
        await shot(`menu-point-${x}-${y}-${theme.id}`);
        await close(page);
      }
      for (
        const [i, edges] of [
          "left:0;top:0",
          "right:0;top:0",
          "left:0;bottom:0",
          "right:0;bottom:0",
        ].entries()
      ) {
        await page.locator(".otk-tabs-project").evaluate((el, edges) => {
          const e = el as HTMLElement;
          e.tabIndex = 0;
          e.style.cssText = "position:fixed;width:160px;height:40px;" + edges;
          e.focus();
        }, edges);
        await page.keyboard.press("ContextMenu");
        const g = await positioned(page, ".otk-tabs-project");
        expect(g.rows.length).toBeGreaterThan(0);
        expect(g.rows.every(Boolean)).toBe(true);
        await shot(`menu-rect-${i}-${theme.id}`);
        await close(page);
      }
      await page.locator(".otk-tabs-project").evaluate((el) =>
        (el as HTMLElement).removeAttribute("style")
      );
      for (const [width, height] of [[1280, 657], [720, 360]]) {
        await page.setViewportSize({ width, height });
        for (
          const [i, position] of [{ top: "50%", bottom: "auto" }, {
            top: "0",
            bottom: "auto",
          }, { top: "auto", bottom: "0" }].entries()
        ) {
          await page.locator(".otk-display-menu > button").evaluate(
            (el, position) =>
              Object.assign((el as HTMLElement).style, {
                position: "fixed",
                left: "50%",
                ...position,
              }),
            position,
          );
          // Match the qualified contract: a synthetic middle/bottom anchor can
          // be under real transcript chrome, so activate its focused control.
          await page.locator(".otk-display-menu > button").focus();
          await page.keyboard.press("Enter");
          const g = await positioned(page, ".otk-display-menu > button");
          expect(g.scroll).toBeGreaterThan(g.body);
          await page.locator(
            ".otk-display-menu :popover-open .otk-surface-body",
          ).evaluate((el) => el.scrollTop = el.scrollHeight);
          expect(
            await page.locator(".otk-display-menu input[name=animationsOff]")
              .evaluate((el) => {
                const r = el.getBoundingClientRect(),
                  hit = document.elementFromPoint(
                    r.x + r.width / 2,
                    r.y + r.height / 2,
                  );
                return !!hit && (hit === el || el.contains(hit));
              }),
          ).toBe(true);
          await shot(`menu-tall-${width}-${i}-${theme.id}`);
          await close(page);
        }
      }
      await page.locator(".otk-display-menu > button").evaluate((el) => {
        const s = (el as HTMLElement).style;
        for (const key of ["position", "left", "top", "bottom"]) {
          s.removeProperty(key);
        }
      });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await fixedContent(state, page, content.sessionID, "menus");
    await state.product("prefs.set", {
      key: "collapseFileChanges",
      value: false,
    });
    for (const theme of themes) {
      await paint(theme);
      for (
        const [name, selector] of [
          ["prompt", ".otk-user-bubble"],
          ["reply", '[data-message="reply"] .otk-text p'],
          ["code", '[data-message="reply"] .otk-code'],
          ["bash", "[data-tool=bash] .otk-tool-toggle"],
          ["patch", "[data-tool=patch] .otk-tool-toggle"],
          ["diff", ".otk-diff .otk-diff-text"],
          [
            "hunk",
            "[data-tool=edit] .otk-diff-content:nth-of-type(2) .otk-diff-text",
          ],
        ]
      ) {
        await reveal(page, selector);
        await page.locator(selector).first().click({ button: "right" });
        await menuGeometry(page);
        await shot(`menu-source-${name}-${theme.id}`);
        await close(page);
      }
    }
  });
}
export async function lights(
  { state, page, themes, scenes, paint, shot }: Inputs,
) {
  const prefs = async (
    key: "showCost" | "reducedColors" | "animationsOff",
    value: boolean,
  ) => {
    await state.product("prefs.set", { key, value });
  };
  await test.step("9/indicator-domains-and-motion", async () => {
    await page.goto(
      scenes + "/?scene=lights&server=" + encodeURIComponent(state.url),
    );
    await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
    for (const theme of themes) {
      await prefs("animationsOff", true);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await paint(theme);
      for (const reduced of [false, true]) {
        await prefs("reducedColors", reduced);
        await expect.poll(() =>
          page.locator("html").evaluate((el) =>
            el.hasAttribute("data-otk-reduced-colors")
          )
        ).toBe(reduced);
        const lamps = await page.locator("[data-theme-lamps] .otk-status-light")
          .evaluateAll((els) =>
            els.map((el) => {
              const s = getComputedStyle(el),
                root = getComputedStyle(document.documentElement),
                body = getComputedStyle(el.querySelector(".otk-lamp-body")!),
                shape = getComputedStyle(el.querySelector(".otk-lamp-shape")!),
                r = el.getBoundingClientRect();
              return {
                state: el.getAttribute("data-state"),
                label: el.getAttribute("aria-label"),
                title: el.getAttribute("title"),
                size: r.width,
                height: r.height,
                color: s.getPropertyValue("--lamp-color").trim(),
                token: root.getPropertyValue(
                  "--otk-lamp-" + el.getAttribute("data-state"),
                ).trim(),
                body: body.display,
                shape: shape.display,
                glyph: el.textContent?.trim(),
                border: body.borderTopWidth,
                rim: body.boxShadow,
                gradient: body.backgroundImage,
              };
            })
          );
        expect(lamps.map((l) => l.state)).toEqual([
          "blocked",
          "working",
          "finished",
          "idle",
          "working",
        ]);
        expect(lamps.map((l) => l.size)).toEqual([10, 10, 10, 10, 8]);
        expect(lamps.slice(0, 4).map((l) => l.label)).toEqual([
          "Needs you",
          "Working",
          "Finished, not seen",
          "Idle",
        ]);
        for (const lamp of lamps) {
          expect(lamp.height).toBe(lamp.size);
          expect(lamp.label).toBeTruthy();
          expect(lamp.title).toBe(lamp.label);
          expect(lamp.color).toBe(lamp.token);
          expect(lamp.token).toMatch(/^#[\da-f]{6}$/i);
          expect(lamp.body).toBe(reduced ? "none" : "block");
          expect(lamp.shape).toBe(reduced ? "block" : "none");
          if (!reduced) {
            expect(lamp.border).toBe("0px");
            expect(lamp.rim).toContain("0px 0px 0px 1px");
            expect(lamp.gradient).toContain("radial-gradient");
            expect(lamp.gradient).toContain("linear-gradient");
          }
        }
        const construction = await page.locator(
          "[data-theme-lamps] .otk-status-light",
        ).evaluateAll((els) =>
          els.map((el) => {
            const glow = getComputedStyle(el.querySelector(".otk-lamp-glow")!),
              body = getComputedStyle(el.querySelector(".otk-lamp-body")!),
              shape = getComputedStyle(el.querySelector(".otk-lamp-shape")!),
              probe = document.createElement("span");
            probe.style.color = "var(--otk-fg)";
            document.body.append(probe);
            const fg = getComputedStyle(probe).color;
            probe.remove();
            return {
              state: el.getAttribute("data-state"),
              glow: glow.display,
              halo: glow.boxShadow,
              shape: shape.color,
              fg,
              body: body.opacity,
            };
          })
        );
        if (!reduced) {
          for (const lamp of construction) {
            expect(lamp.glow === "none").toBe(lamp.state === "idle");
            if (lamp.state !== "idle") expect(lamp.halo).toContain("6px");
            expect(lamp.body).toBe("1");
          }
        } else {
          construction.forEach((l) => expect(l.shape).toBe(l.fg));
          const ratios = await page.evaluate(() => {
            const canvas = document.createElement("canvas"),
              sample = document.createElement("span");
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext("2d")!;
            document.body.append(sample);
            const luminance = (value: string) => {
              sample.style.color = `var(--otk-${value})`;
              ctx.clearRect(0, 0, 1, 1);
              ctx.fillStyle = getComputedStyle(sample).color;
              ctx.fillRect(0, 0, 1, 1);
              return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
                .map((v) => v / 255).map((v) =>
                  v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
                ).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
            };
            const ratio = (a: string, b: string) => {
              const x = luminance(a), y = luminance(b);
              return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
            };
            const results = [ratio("action", "action-on")];
            for (const bg of ["bg", "bg-side", "surface", "surface-2"]) {
              results.push(ratio("action-text", bg), ratio("action-focus", bg));
            }
            sample.remove();
            return results;
          });
          ratios.forEach((v, i) =>
            expect(v).toBeGreaterThanOrEqual(i === 0 || i % 2 ? 4.5 : 3)
          );
        }
        expect(lamps.slice(0, 4).map((l) => l.glyph)).toEqual([
          "\u00d7",
          "\u25d0",
          "\u2713",
          "\u25cb",
        ]);
        const connections = await page.locator(
          "[data-theme-connections] .otk-connection-light",
        ).evaluateAll((els) =>
          els.map((el) => {
            const state = el.getAttribute("data-connection-state")!,
              s = getComputedStyle(el),
              slot = state === "reconnecting" ? "connecting" : state;
            return {
              state,
              color: s.getPropertyValue("--connection-color").trim(),
              token: getComputedStyle(document.documentElement)
                .getPropertyValue("--otk-connection-" + slot).trim(),
              size: el.getBoundingClientRect().width,
              label: el.getAttribute("aria-label"),
              glyph: el.textContent?.trim(),
              dot: getComputedStyle(el.querySelector(".otk-connection-dot")!)
                .display,
              shape:
                getComputedStyle(el.querySelector(".otk-connection-shape")!)
                  .display,
            };
          })
        );
        expect(connections.map((c) => c.state)).toEqual([
          "connected",
          "connecting",
          "reconnecting",
          "disconnected",
          "error",
        ]);
        expect(connections.map((c) => c.glyph)).toEqual([
          "\u2713",
          "\u25cc",
          "\u21bb",
          "\u25cb",
          "\u00d7",
        ]);
        for (const connection of connections) {
          expect(connection.color).toBe(connection.token);
          expect(connection.token).toMatch(/^#[\da-f]{6}$/i);
          expect(connection.size).toBe(10);
          expect(connection.label).toBeTruthy();
          expect(connection.dot).toBe(reduced ? "none" : "block");
          expect(connection.shape).toBe(reduced ? "block" : "none");
        }
        await shot(`lights-${reduced}-${theme.id}`);
        if (reduced) {
          expect(
            await page.locator("[data-age]").evaluateAll((els) =>
              els.map((el) => {
                const s = getComputedStyle(el);
                return [s.textDecorationStyle, s.textDecorationLine];
              })
            ),
          ).toEqual([["solid", "none"], ["dotted", "underline"], [
            "wavy",
            "underline",
          ], ["double", "underline"]]);
          await expect(page.locator(".otk-activity-shape")).toHaveText(
            "\u25d0",
          );
          await expect(page.locator(".otk-activity-spinner")).toHaveCSS(
            "display",
            "none",
          );
        }
      }
      await prefs("reducedColors", false);
      await prefs("animationsOff", false);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const glow = page.locator(
        "[data-theme-lamps] [data-state=working] .otk-lamp-glow",
      ).first();
      await expect(glow).toHaveCSS("animation-name", "otk-lamp-breathe");
      const cycle = await glow.evaluate(async (el) => {
        const a = el.getAnimations()[0], start = a.currentTime as number;
        const body = el.parentElement!.querySelector(".otk-lamp-body")!;
        const before = getComputedStyle(body).backgroundImage +
          getComputedStyle(body).opacity;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
        const progressing = (a.currentTime as number) > start;
        a.pause();
        const shadows = [];
        for (const time of [0, 1300, 2600]) {
          a.currentTime = time;
          shadows.push(getComputedStyle(el).boxShadow);
        }
        a.play();
        return {
          duration: a.effect!.getTiming().duration,
          iterations: String(a.effect!.getTiming().iterations),
          progressing,
          shadows,
          bodySteady: before ===
            getComputedStyle(body).backgroundImage +
              getComputedStyle(body).opacity,
          gel: getComputedStyle(el.parentElement!).getPropertyValue(
            "--lamp-color",
          ).trim(),
        };
      });
      expect(cycle.duration).toBe(2600);
      expect(cycle.iterations).toBe("Infinity");
      expect(cycle.progressing).toBe(true);
      expect(cycle.bodySteady).toBe(true);
      const rgb = [1, 3, 5].map((i) => parseInt(cycle.gel.slice(i, i + 2), 16));
      expect(rgb[1]).toBeGreaterThan(rgb[0]);
      expect(rgb[1]).toBeGreaterThan(rgb[2]);
      expect(cycle.shadows[0]).toContain("3px");
      expect(cycle.shadows[1]).toContain("12px");
      expect(cycle.shadows[0]).not.toBe(cycle.shadows[1]);
      expect(cycle.shadows[0]).toBe(cycle.shadows[2]);
      await expect(page.locator(".otk-activity-spinner")).toHaveCSS(
        "animation-name",
        "otk-activity-spin",
      );
      await expect(page.locator(".otk-activity-spinner")).toHaveCSS(
        "animation-duration",
        "1.1s",
      );
      expect(
        (await page.locator(".otk-activity-indicator").boundingBox())!.width,
      ).toBe(8);
      await page.locator("[data-light-event]").click();
      const blink = page.locator("[data-theme-lamps] .otk-status-light")
        .first();
      await expect(blink).toHaveAttribute("data-blink", "");
      const body = blink.locator(".otk-lamp-body");
      await expect(body).toHaveCSS("animation-name", "otk-lamp-blink");
      const opacity = await body.evaluate((el) => {
        const a = el.getAnimations()[0];
        a.pause();
        a.currentTime = 90;
        const dip = Number(getComputedStyle(el).opacity);
        a.currentTime = 250;
        const restored = Number(getComputedStyle(el).opacity);
        a.play();
        return [dip, restored];
      });
      expect(Math.abs(opacity[0] - .2)).toBeLessThan(.01);
      expect(opacity[1]).toBe(1);
      let steady: unknown;
      for (const source of ["setting", "system"]) {
        await prefs("animationsOff", source === "setting");
        await page.emulateMedia({
          reducedMotion: source === "system" ? "reduce" : "no-preference",
        });
        await expect(glow).toHaveCSS("animation-name", "none");
        const current = await glow.evaluate((el) => {
          const s = getComputedStyle(el);
          return { shadow: s.boxShadow, opacity: s.opacity };
        });
        expect(current.shadow).not.toBe("none");
        if (steady) expect(current).toEqual(steady);
        steady = current;
        await expect(page.locator(".otk-activity-spinner")).toHaveCSS(
          "animation-name",
          "none",
        );
        await page.locator("[data-light-event]").click();
        expect(
          await page.locator("[data-theme-lamps]").evaluate((el) =>
            el.getAnimations({ subtree: true }).length
          ),
        ).toBe(0);
        await shot(`lights-motion-${source}-${theme.id}`);
      }
    }
    await prefs("animationsOff", true);
    await prefs("reducedColors", false);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  });
}
export async function collections789(inputs: Inputs) {
  await usage(inputs);
  await surfaces(inputs);
  await lights(inputs);
}
