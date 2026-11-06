// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { activity, sessionContext } from "../../pages/sessions.ts";
import type { Page } from "@playwright/test";

const viewport = ".otk-project-session-tree";
async function scroll(page: Page, top: number | "end") {
  const pane = page.locator(viewport);
  const delta = await pane.evaluate(
    (e, top) =>
      (top === "end" ? e.scrollHeight - e.clientHeight : top) - e.scrollTop,
    top,
  );
  if (Math.abs(delta) < 1) return;
  await pane.hover();
  await page.mouse.wheel(0, delta);
  await expect.poll(() =>
    pane.evaluate(
      (e, top) =>
        Math.abs(
          e.scrollTop - (top === "end" ? e.scrollHeight - e.clientHeight : top),
        ),
      top,
    )
  ).toBeLessThan(1);
}
const anchor = (page: Page) =>
  page.locator(viewport).evaluate((v) => {
    const r = v.getBoundingClientRect();
    const row = Array.from(
      v.querySelectorAll<HTMLElement>("[data-virtual-key]"),
    ).find((e) => e.getBoundingClientRect().bottom > r.top + .5)!;
    return {
      key: row.dataset.virtualKey!,
      offset: row.getBoundingClientRect().top - r.top,
      top: v.scrollTop,
    };
  });
test.describe("direct route", () => {
  test.use({ profile: "contract-sessions-direct" });
  test(
    "sessions.direct-route-task-metadata-before-hierarchy-held-transcript-independent-paint",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      await state.product("layout.patch", {
        rightCollapsed: false,
        rightView: "sessions",
      });
      await state.product("tasks.create", {
        directory: state.directory,
        name: "Initial grouped work",
        sessions: ["tstv1-core"],
      });
      const frames = await wire(page);
      frames.hold((f) => ["inbox.snapshot", "inbox.patch"].includes(f.t));
      await page.goto(`${state.url}/#/local/tstv1-core`);
      await expect.poll(async () =>
        (await state.observe<{ reads: number }>()).reads
      ).toBeGreaterThan(0);
      await expect.poll(() => frames.held.length).toBeGreaterThan(0);
      await expect(page.locator(".otk-session-row")).toHaveCount(0);
      frames.release();
      const row = page.locator(
        '.otk-session-row[data-session="tstv1-core"][aria-current="page"]',
      );
      await expect(row).toBeVisible({ timeout: 2000 });
      await expect.poll(() =>
        row.evaluate((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top >= 0 &&
            r.bottom <= innerHeight;
        }), { timeout: 2000 }).toBe(true);
      await expect(page.locator(".otk-session-row")).toHaveCount(1);
      await expect(
        page.locator(
          ".otk-session-group-heading[data-session-group] .otk-control-label",
        ).first(),
      ).toHaveText("Initial grouped work");
      await expect(page.locator("body")).not.toContainText("Core transcript");
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "release",
      });
      await expect(page.locator(".otk-messages")).toContainText(
        "Core transcript",
      );
    },
  );
});
test.describe("measured Sessions", () => {
  test.use({ profile: "contract-sessions-window" });
  test(
    "sessions.virtual-list-bounded-dom-no-row-body-reads-unmounts-on-collapse",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      await state.product("tasks.create", {
        directory: state.directory,
        name: "Selected transcript scope",
        sessions: ["tstv1-otk"],
      });
      const frames = await wire(page);
      await openSession(state, page, "tstv1-otk");
      await expect(page.locator(".otk-session-row").first()).toBeVisible();
      expect(await page.locator(".otk-session-row").count()).toBeLessThan(40);
      expect(frames.sent.filter(({ frame }) =>
        [
          "session.get",
          "session.messages",
          "session.children",
          "models.list",
          "usage.get",
        ].includes(String(frame.method)) &&
        frame.params?.sessionID !== "tstv1-otk"
      )).toEqual([]);
      await page.locator(".otk-panel-collapse").click();
      await expect(page.locator(".otk-right-rail")).toBeVisible();
      await expect(page.locator(".otk-project-sessions")).toHaveCount(0);
    },
  );
  test(
    "sessions.measured-window-identity-focus-menu-search-anchor-editor-and-scope",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      test.setTimeout(90_000);
      const task = await state.product("tasks.create", {
        directory: state.directory,
        name: "Windowed execution",
        sessions: ["tstv1-w-10", "tstv1-w-11"],
      });
      const frames = await wire(page);
      await openSession(state, page, "tstv1-otk");
      await scroll(page, "end");
      const last = page.locator("[data-session=tstv1-w-299]");
      await expect(last).toBeVisible();
      expect(
        await last.evaluate((e) => {
          const row = e.closest("[role=listitem]")!;
          return [
            row.getAttribute("aria-posinset"),
            row.getAttribute("aria-setsize"),
          ];
        }),
      ).toEqual(["302", "302"]);
      await expect(last.locator(".otk-session-cost")).toHaveText("$0.13");
      expect(await page.locator(".otk-session-row").count()).toBeLessThan(40);
      await last.evaluate((e) => {
        Object.assign(globalThis, { pinnedSessionRow: e });
        (e as HTMLElement).focus();
      });
      await scroll(page, 0);
      await expect.poll(() =>
        page.evaluate(
          "document.activeElement===globalThis.pinnedSessionRow && pinnedSessionRow.isConnected",
        )
      ).toBe(true);
      await expect(page.locator("[data-session=tstv1-w-10]")).toBeVisible();
      const search = page.getByRole("searchbox", {
        name: "Search sessions by title",
      });
      await search.focus();
      await expect(last).toHaveCount(0);
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "fail",
        sessionID: "tstv1-w-299",
      });
      await sessionContext(page, "[data-session=tstv1-w-10]");
      await scroll(page, "end");
      await expect(last.locator(".otk-session-cost")).toHaveText("$2.50");
      await expect(page.locator("[data-session=tstv1-w-10]")).toBeAttached();
      await page.keyboard.press("Escape");
      await search.focus();
      await scroll(page, "end");
      await expect(page.locator("[data-session=tstv1-w-10]")).toHaveCount(0);
      await search.fill("Nested search");
      await expect(page.locator(".otk-session-row")).toHaveCount(2);
      await expect(page.locator("[data-session=tstv1-helper]")).toBeVisible();
      await page.locator("[data-session=tstv1-helper]").click();
      await expect(page).toHaveURL(/tstv1-helper$/);
      await page.locator("[data-panel-view=timeline]").click();
      await expect(page.locator(".otk-project-sessions")).toHaveCount(0);
      await page.locator("[data-panel-view=sessions]").click();
      await expect(search).toHaveValue("Nested search");
      await search.fill("");
      await scroll(page, 3000);
      const before = await anchor(page);
      await state.product("tasks.sessions", {
        id: task.id,
        sessions: ["tstv1-w-11", "tstv1-w-10"],
      });
      await activity(state, "tstv1-w-250", "hold");
      await expect(page.locator("[data-tab=tstv1-w-250]")).toBeVisible();
      await expect.poll(async () => {
        const a = await anchor(page);
        return a.key === before.key && Math.abs(a.offset - before.offset) < 1;
      }).toBe(true);
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "fail",
        sessionID: before.key,
        target: "backgrounds",
      });
      await expect(page.locator(`[data-session="${before.key}"]`)).toHaveClass(
        /is-deleted/,
      );
      await expect.poll(async () => {
        const a = await anchor(page);
        return a.key === before.key && Math.abs(a.offset - before.offset) < 1;
      }).toBe(true);
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "fail",
        sessionID: before.key,
      });
      await expect(page.locator(`[data-session="${before.key}"]`)).not
        .toHaveClass(/is-deleted/);
      await page.locator(".otk-panel-collapse").click();
      await expect(page.locator(".otk-project-sessions .otk-virtual-list"))
        .toHaveCount(0);
      await page.locator(".otk-right-rail [data-panel-view=sessions]").click();
      await expect.poll(async () => {
        const a = await anchor(page);
        return a.top > 2900 && a.key === before.key &&
          Math.abs(a.offset - before.offset) < 1;
      }).toBe(true);
      await page.locator(
        '[data-project$="/projects/atmosphera"] .otk-project-open',
      ).click();
      await expect(search).toHaveValue("");
      await expect(page.locator("[data-session=tstv1-w-99]")).toHaveCount(0);
      await search.fill("Approval");
      await page.locator('[data-project$="/projects/otk"] .otk-project-open')
        .click();
      await expect(search).toHaveValue("");
      await expect.poll(() =>
        page.locator(viewport).evaluate((e) => e.scrollTop)
      ).toBeGreaterThan(2900);
      await scroll(page, 1500);
      await expect(page.locator("[data-session=tstv1-w-50]")).toBeAttached();
      await sessionContext(page, "[data-session=tstv1-w-50]", "session.rename");
      const input = page.getByRole("textbox", {
        name: "Rename session",
        exact: true,
      });
      await input.fill("Retained editor");
      await scroll(page, 3000);
      const editing = await anchor(page);
      await input.press("Enter");
      await expect(page.locator(".otk-title-editor [role=alert]"))
        .toBeVisible();
      await expect.poll(() =>
        page.locator(".otk-session-row.is-editing").evaluate((e) =>
          e.getBoundingClientRect().height
        )
      ).toBeGreaterThan(30);
      await expect.poll(async () => {
        const a = await anchor(page);
        return a.key === editing.key && Math.abs(a.offset - editing.offset) < 1;
      }).toBe(true);
      expect(
        await page.locator(viewport).evaluate((e) =>
          e.scrollWidth <= e.clientWidth
        ),
      ).toBe(true);
      expect(
        await page.locator(".otk-session-row.is-editing").evaluate((row) => {
          const selectors = [
            "input",
            ".otk-status-light",
            ".otk-list-row-trailing",
          ];
          const ys = selectors.map((s) => {
            const r = row.querySelector(s)!.getBoundingClientRect();
            return r.y + r.height / 2;
          });
          return Math.max(...ys) - Math.min(...ys) <= 1;
        }),
      ).toBe(true);
      await search.fill("No matching sessions while editing");
      await expect(page.locator(".otk-session-row")).toHaveCount(1);
      await expect(input).toHaveValue("Retained editor");
      // Filtering blurs the title input and owns a second rejected save. Join
      // that real intent before retrying; Enter during readonly/pending is inert.
      await expect(input).not.toHaveAttribute("aria-busy", "true");
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "succeed",
      });
      await input.click();
      await input.press("Enter");
      await expect(page.locator(".otk-title-editor")).toHaveCount(0);
      await expect(page.locator(".otk-project-sessions")).toContainText(
        "No matching sessions",
      );
      expect(
        (await state.product("session.get", { sessionID: "tstv1-w-50" })).title,
      ).toBe("Retained editor");
      await search.fill("");
      for (const width of [280, 480]) {
        await state.product("layout.patch", { rightWidth: width });
        await expect.poll(() =>
          page.locator(".otk-right-panel").evaluate((e) =>
            e.getBoundingClientRect().width
          )
        ).toBe(width);
        expect(
          await page.locator(".otk-session-row").evaluateAll((es) =>
            es.every((e) => {
              const a = e.querySelector(".otk-status-light")!
                  .getBoundingClientRect(),
                b = e.querySelector(".otk-row-title")!.getBoundingClientRect();
              return Math.abs(a.y + a.height / 2 - b.y - b.height / 2) <= 1;
            })
          ),
        ).toBe(true);
        expect(
          await page.locator(".otk-session-row .otk-row-title").evaluateAll(
            (es) =>
              es.every((e) => getComputedStyle(e).whiteSpace === "nowrap"),
          ),
        ).toBe(true);
        const gaps = await page.locator(".otk-panel-new-session").evaluate(
          (e) => {
            const c = e.getBoundingClientRect(),
              i = e.querySelector("svg")!.getBoundingClientRect();
            return [
              i.top - c.top,
              c.bottom - i.bottom,
              c.right - i.right,
              i.left - c.left,
            ];
          },
        );
        expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
      }
      expect(frames.sent.filter(({ frame }) => frame.method === "usage.get"))
        .toHaveLength(0);
    },
  );
});
