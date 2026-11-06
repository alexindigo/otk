// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import { activity, collapsed, visibleOnScreen } from "../../pages/sessions.ts";

test.describe("task tabs", () => {
  test.use({ profile: "contract-sessions-tabs" });
  test(
    "sessions.task-tabs-native-create-rename-order-close-crumbs-meter-draft-and-reload",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      await openSession(state, page, "tstv1-otk");
      for (const name of ["Plan", "Execution"]) {
        await page.locator(".otk-task-new").click();
        await page.locator("input[name=taskName]").fill(name);
        await page.locator("dialog button[type=submit]").click();
        await expect(page.locator("dialog")).toHaveCount(0);
      }
      const tasks = await state.product("tasks.list", {
          directory: state.directory,
        }),
        plan = tasks.find((t) => t.name === "Plan")!,
        exec = tasks.find((t) => t.name === "Execution")!;
      await state.product("tasks.sessions", {
        id: exec.id,
        sessions: ["tstv1-otk", "tstv1-second"],
      });
      await activity(state, "tstv1-helper", "hold");
      await activity(state, "tstv1-nested", "hold");
      await page.locator(`[data-tab="${exec.id}"]`).click();
      await expect(page.locator("[data-crumb=tstv1-otk]")).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page.locator("[data-crumb=tstv1-helper][data-helper=true]"))
        .toBeVisible();
      await expect(page.locator(".otk-context-meter")).toHaveAttribute(
        "data-tokens",
        "2670",
      );
      await expect(page.locator(".otk-context-meter")).toHaveAttribute(
        "data-cost",
        "0.125",
      );
      await expect(page.locator(".otk-context-meter")).not.toContainText("%");
      await expect(page.locator(".otk-context-bar")).toHaveCount(0);
      await page.locator("[data-crumb=tstv1-helper]").click();
      await expect(page).toHaveURL(/tstv1-otk\/tstv1-helper$/);
      await expect(page.locator("[data-crumb=tstv1-nested]")).toHaveAttribute(
        "data-depth",
        "2",
      );
      await page.locator("[data-crumb=tstv1-nested]").click();
      await expect(page).toHaveURL(/tstv1-otk\/tstv1-nested$/);
      await page.locator("[data-crumb=tstv1-helper]").click();
      await page.reload();
      await expect(page.locator("[data-crumb=tstv1-helper]")).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page.locator(`[data-tab="${exec.id}"]`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.locator("[data-crumb=tstv1-second]").click();
      await expect(page).toHaveURL(/tstv1-second$/);
      await page.locator(`[data-tab="${plan.id}"]`).click();
      await page.locator(`[data-tab="${exec.id}"]`).click();
      await expect(page).toHaveURL(/tstv1-second$/);
      await expect(page.locator("[data-crumb=tstv1-second]")).toHaveAttribute(
        "aria-current",
        "page",
      );
      await page.locator("textarea[name=prompt]").fill("Keep the task draft");
      await page.locator(`[data-tab="${plan.id}"]`).click();
      await expect(page).not.toHaveURL(/tstv1-second$/);
      await page.locator(`[data-tab="${exec.id}"]`).click();
      await expect(page.locator("textarea[name=prompt]")).toHaveValue(
        "Keep the task draft",
      );
      await page.locator("textarea[name=prompt]").fill("");
      await state.product("tasks.rename", { id: exec.id, name: "Build" });
      await expect(page.locator(`[data-tab="${exec.id}"]`)).toContainText(
        "Build",
      );
      expect(
        (await state.product("tasks.list", { directory: state.directory }))
          .find((t) => t.id === exec.id)!
          .name,
      ).toBe("Build");
      for (
        const ids of [[exec.id, plan.id], [plan.id, exec.id], [
          exec.id,
          plan.id,
        ]]
      ) {
        await state.product("tasks.reorder", {
          directory: state.directory,
          ids,
        });
        await expect(page.locator(".otk-tab-open").first()).toHaveAttribute(
          "data-tab",
          exec.id,
        );
      }
      expect(
        (await state.product("tasks.list", { directory: state.directory }))
          .sort((a, b) => a.order - b.order).map((t) => t.id),
      ).toEqual([exec.id, plan.id]);
      await activity(state, "tstv1-helper", "release");
      await activity(state, "tstv1-nested", "release");
      await expect(
        page.locator("[data-crumb=tstv1-helper], [data-crumb=tstv1-nested]"),
      )
        .toHaveCount(0);
      await expect(
        page.locator("[data-tab=tstv1-helper], [data-tab=tstv1-nested]"),
      )
        .toHaveCount(0);
      await page.locator(".otk-new-session").click();
      await expect(page.locator("[data-crumb]")).toHaveCount(3);
      expect(
        (await state.product("tasks.list", { directory: state.directory }))
          .find((t) => t.id === exec.id)!
          .sessions,
      ).toHaveLength(3);
      await page.reload();
      await expect(page.locator(".otk-tab-open").first()).toHaveAttribute(
        "data-tab",
        exec.id,
      );
      await state.product("tasks.close", { id: exec.id });
      await expect(page.locator(`[data-tab="${exec.id}"]`)).toHaveCount(0);
      for (const id of ["tstv1-otk", "tstv1-second"]) {
        expect(await state.product("session.get", { sessionID: id }))
          .toBeTruthy();
      }
      expect(
        (await state.product("tasks.list", { directory: state.directory }))
          .some((t) => t.id === plan.id),
      ).toBe(true);
    },
  );
  test("sessions.long-task-chain-fold-reveal-and-reduced-color-light", {
    tag: ["@sessions", "@contracts", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const ids = [
      "tstv1-otk",
      ...Array.from({ length: 9 }, (_, i) => `tstv1-chain-${i}`),
    ];
    const task = await state.product("tasks.create", {
      directory: state.directory,
      name: "Long chain",
      sessions: ids,
    });
    await page.goto(`${state.url}/#/local/tstv1-otk`);
    await expect(page.locator(".otk-folded-crumbs")).toBeVisible();
    expect(await page.locator("[data-crumb]:visible").count()).toBeLessThan(10);
    await page.locator(".otk-folded-crumbs > button").click();
    const choice = page.locator(".otk-folded-crumbs .otk-menu-items button")
      .nth(1);
    const id = await choice.getAttribute("data-overflow-target");
    expect(ids).toContain(id);
    await choice.click();
    await expect(page.locator(`[data-crumb="${id}"]`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page).toHaveURL(new RegExp(`${id}$`));
    await expect(page.locator(`[data-tab="${task.id}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await state.product("prefs.set", { key: "reducedColors", value: true });
    await expect(page.locator("html")).toHaveAttribute(
      "data-otk-reduced-colors",
      "",
    );
    await expect(page.locator(`[data-crumb="${id}"] .otk-lamp-shape`))
      .toHaveCSS("display", "block");
  });
});

test.describe("phantom ownership", () => {
  test.use({ profile: "contract-sessions-phantom" });
  test(
    "sessions.axiom-three-mandatory-phantoms-inactive-rail-collapsed-reload",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      await state.product("projects.visit", {
        directory: state.directory,
        active: true,
      });
      await state.product("projects.inactive", {
        directory: state.directory,
        inactive: true,
      });
      await activity(state, "tstv1-otk", "hold");
      await activity(state, "tstv1-blocked", "freeze");
      await activity(state, "tstv1-finished", "hold");
      await activity(state, "tstv1-finished", "release");
      await openSession(state, page, "tstv1-otk");
      await page.getByRole("button", { name: "Collapse projects", exact: true })
        .click();
      await page.locator(".otk-panel-collapse").click();
      for (let reload = 0; reload < 2; reload++) {
        if (reload) await page.reload();
        await collapsed(page);
        for (
          const [id, status] of [["tstv1-otk", "working"], [
            "tstv1-blocked",
            "blocked",
          ], ["tstv1-finished", "finished"]]
        ) {
          await visibleOnScreen(
            page.locator(
              `[data-tab=${id}] .otk-status-light[data-state=${status}]`,
            ),
          );
        }
        const light = page.locator(
          `[data-project=${
            JSON.stringify(state.directory)
          }] .otk-status-light[data-state=blocked]`,
        );
        await visibleOnScreen(light);
        expect(
          (await light.boundingBox())!.x + (await light.boundingBox())!.width,
        ).toBeLessThanOrEqual(48);
      }
      expect(
        (await state.product("inbox.get", {})).inbox.projects.find((p) =>
          p.directory === state.directory
        )!.inactive,
      ).toBe(false);
    },
  );
  test(
    "sessions.phantom-preview-pin-double-send-membership-and-idle-seen-departure",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      await activity(state, "tstv1-otk", "hold");
      await openSession(state, page, "tstv1-preview-a");
      await expect(
        page.locator(".otk-tab[data-preview=true] [data-tab=tstv1-preview-a]"),
      ).toBeVisible();
      await openSession(state, page, "tstv1-preview-b");
      await expect(page.locator("[data-tab=tstv1-preview-a]")).toHaveCount(0);
      await visibleOnScreen(page.locator("[data-tab=tstv1-otk]"));
      await expect(page.locator("[data-tab=tstv1-preview-b]")).toHaveCSS(
        "font-style",
        "italic",
      );
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "hold",
        sessionID: "tstv1-preview-b",
        target: "tabs-pin",
      });
      await expect(
        page.locator(".otk-tab[data-kind=task]").filter({
          hasText: "preview-b",
        }),
      ).toBeVisible();
      await openSession(state, page, "tstv1-double");
      await page.locator("[data-tab=tstv1-double]").dblclick();
      await expect(
        page.locator(".otk-tab[data-kind=task]").filter({ hasText: "double" }),
      ).toBeVisible();
      await openSession(state, page, "tstv1-send");
      await prompt(page, "Promote by sending");
      await expect(
        page.locator(".otk-tab[data-kind=task]").filter({ hasText: "send" }),
      ).toBeVisible();
      await expect(page.locator("textarea[name=prompt]")).toHaveValue("");
      await openSession(state, page, "tstv1-pin");
      const task =
        (await state.product("tasks.list", { directory: state.directory }))
          .find((t) => t.name === "send")!;
      await state.product("tasks.addSession", {
        id: task.id,
        sessionID: "tstv1-pin",
      });
      await expect(page.locator("[data-tab=tstv1-pin]")).toHaveCount(0);
      expect(
        (await state.product("tasks.list", { directory: state.directory }))
          .find((t) => t.id === task.id)!
          .sessions,
      ).toContain("tstv1-pin");
      await page.locator("[data-tab=tstv1-otk]").click();
      await activity(state, "tstv1-otk", "release");
      await expect(page.locator("[data-tab=tstv1-otk]")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await state.product("sessions.seen", { sessionID: "tstv1-otk" });
      await page.locator(`[data-tab="${task.id}"]`).click();
      await expect(page.locator("[data-tab=tstv1-otk]")).toHaveCount(0);
      expect(await state.product("session.get", { sessionID: "tstv1-otk" }))
        .toBeTruthy();
    },
  );
});
