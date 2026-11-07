// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { activity, collapsed, visibleOnScreen } from "../../pages/sessions.ts";

test.describe("inactive supervision", () => {
  test.use({ profile: "contract-sessions-inbox" });
  test(
    "sessions.inactive-projects-three-required-lights-after-collapsed-reload",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      const { entries } = await state.observe<
        { entries: { id: string; directory: string }[] }
      >();
      for (const entry of entries.slice(0, 4)) {
        await state.product("projects.visit", {
          directory: entry.directory,
          active: true,
        });
      }
      await openSession(state, page, "tstv1-other-finished");
      await page.locator(".otk-panel-collapse").click();
      await expect(page.locator(".otk-right-panel")).toBeHidden();
      for (const entry of entries.slice(0, 3)) {
        const row = page.locator(
          `[data-project=${JSON.stringify(entry.directory)}]`,
        );
        await row.locator(".otk-project-menu > button").click();
        await row.locator(".otk-menu-items button").click();
        await expect(row).toHaveCount(0);
      }
      await expect(page.locator(".otk-inactive-toggle")).toContainText("(3)");
      await activity(state, "tstv1-otk", "hold");
      await activity(state, "tstv1-atmosphera", "thaw");
      await activity(state, "tstv1-globnotes", "hold");
      await activity(state, "tstv1-globnotes", "release");
      const states = ["working", "blocked", "finished"];
      for (let i = 0; i < 3; i++) {
        await expect(
          page.locator(
            `[data-project=${JSON.stringify(entries[i].directory)}]`,
          ),
        ).toHaveAttribute("data-rollup", states[i]);
      }
      expect(
        (await state.product("inbox.get", {})).inbox.projects.every((p) =>
          !p.inactive
        ),
      ).toBe(true);
      await page.getByRole("button", { name: "Collapse projects", exact: true })
        .click();
      for (let reload = 0; reload < 2; reload++) {
        if (reload) await page.reload();
        await collapsed(page);
        for (let i = 0; i < 3; i++) {
          await visibleOnScreen(
            page.locator(
              `[data-project=${
                JSON.stringify(entries[i].directory)
              }] .otk-status-light[data-state=${states[i]}]`,
            ),
          );
        }
      }
      await page.getByRole("button", { name: "Expand projects", exact: true })
        .click();
      const unread = page.locator(
        `[data-project=${
          JSON.stringify(entries[2].directory)
        }] .otk-project-name`,
      );
      await expect(unread).toHaveAttribute("data-unread", "true");
      await openSession(state, page, "tstv1-other-finished");
      await expect(unread).toHaveAttribute("data-unread", "true");
      await openSession(state, page, "tstv1-globnotes");
      await expect(unread).toHaveAttribute("data-unread", "false");
    },
  );
});

test.describe("filtered and unmounted supervision", () => {
  test.use({ profile: "contract-sessions-axiom" });
  test(
    "sessions.axiom-filtered-offscreen-unmounted-collapsed-reload-mandatory-tabs",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      await openSession(state, page, "tstv1-otk");
      const search = page.getByRole("searchbox", {
        name: "Search sessions by title",
      });
      await search.fill("no matching title");
      const project = '[data-project$="/projects/atmosphera"]';
      for (const stage of ["filtered", "offscreen", "unmounted", "collapsed"]) {
        if (stage === "offscreen") {
          await search.fill("");
          await page.locator(".otk-project-session-tree").hover();
          // Q3 paging can extend the end after a gesture; reach the same exact
          // offscreen setup through real input, without assuming a full catalog.
          await expect.poll(async () => {
            await page.mouse.wheel(0, 100000);
            return page.locator("[data-session=tstv1-axiom-99]").count();
          }).toBe(1);
          await expect(page.locator("[data-session=tstv1-axiom-99]"))
            .toBeAttached();
        }
        if (stage === "unmounted") {
          await page.locator("[data-panel-view=timeline]").click();
          await expect(page.locator(".otk-project-sessions")).toHaveCount(0);
        }
        if (stage === "collapsed") {
          await page.getByRole("button", {
            name: "Collapse projects",
            exact: true,
          }).click();
          await page.locator(".otk-panel-collapse").click();
          await collapsed(page);
        }
        for (const status of ["working", "blocked", "finished"]) {
          await activity(state, "tstv1-atmosphera", "hold");
          if (status === "blocked") {
            await activity(state, "tstv1-atmosphera", "freeze");
          }
          if (status === "finished") {
            await activity(state, "tstv1-atmosphera", "release");
          }
          await visibleOnScreen(
            page.locator(`${project} .otk-status-light[data-state=${status}]`),
          );
        }
      }
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "hold",
        target: "backgrounds",
      });
      const { entries } = await state.observe<
        { entries: { id: string; directory: string }[] }
      >();
      const other = entries.find((e) => e.id === "tstv1-atmosphera")!;
      await state.product("layout.location", {
        sidecarId: "local",
        directory: other.directory,
        sessionID: "tstv1-background-working",
      });
      await page.reload();
      await collapsed(page);
      await visibleOnScreen(
        page.locator(`${project} .otk-status-light[data-state=blocked]`),
      );
      await page.locator(`${project} .otk-project-open`).click();
      await expect(page).toHaveURL(/tstv1-background-working$/);
      for (
        const [id, status] of [["tstv1-atmosphera", "finished"], [
          "tstv1-background-working",
          "working",
        ], ["tstv1-background-blocked", "blocked"]]
      ) {
        await visibleOnScreen(
          page.locator(
            `[data-tab=${id}] .otk-status-light[data-state=${status}]`,
          ),
        );
      }
      await expect(page.locator(".otk-project-sessions")).toHaveCount(0);
    },
  );
});
