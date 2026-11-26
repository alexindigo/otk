// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import { activity, collapsed, visibleOnScreen } from "../../pages/sessions.ts";

test.describe("task tabs", () => {
  test.use({ profile: "contract-sessions-tabs" });
  test(
    "sessions.human-task-identity-helper-crumb-attention-sticky-and-reload",
    {
      tag: ["@sessions", "@contracts", "@isolated"],
    },
    async ({ isolatedState: state, page }) => {
      const root = "tstv1-otk", helper = "tstv1-helper";
      await activity(state, helper, "hold");
      await openSession(state, page, root);
      const assertTask = async () => {
        await expect(page.locator(`[data-tab="${helper}"]`)).toHaveCount(0);
        await expect(page.locator(`[data-tab="${root}"]`)).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(
          page.getByRole("button", { name: /^Subagents:/ }),
        ).toHaveAccessibleName("Subagents: 1 running");
      };
      await assertTask();
      await expect(page.locator(`[data-crumb="${helper}"]`)).toHaveCount(0);
      await page.getByRole("button", { name: /^Subagents:/ })
        .click();
      await page.locator(`[data-subagent="${helper}"] .otk-subagent-name`)
        .click();
      await expect(page).toHaveURL(new RegExp(`${helper}$`));
      await assertTask();
      await page.reload();
      await assertTask();
      const project = page.locator(
        `.otk-project-row[data-project=${JSON.stringify(state.directory)}]`,
      );
      await project.locator(".otk-project-attention").click();
      await expect(page).toHaveURL(new RegExp(`${helper}$`));
      await assertTask();
      await openSession(state, page, "tstv1-atmosphera");
      await project.locator(".otk-project-open").click();
      await expect(page).toHaveURL(new RegExp(`${helper}$`));
      await assertTask();
      expect(await state.product("tasks.list", { directory: state.directory }))
        .toEqual([]);
    },
  );
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
      await expect(page.locator("[data-crumb=tstv1-helper]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Subagents:/ }))
        .toHaveAccessibleName("Subagents: 2 running");
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
      await page.locator('[data-session="tstv1-helper"]').click();
      await expect(page).toHaveURL(/tstv1-otk\/tstv1-helper$/);
      await expect(page.locator("[data-crumb=tstv1-nested]")).toHaveCount(0);
      await page.locator('[data-session="tstv1-nested"]').click();
      await expect(page.locator("[data-crumb=tstv1-nested]")).toHaveAttribute(
        "data-depth",
        "2",
      );
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
      await expect(page.locator("[data-crumb=tstv1-second]")).toHaveCount(0);
      await openSession(state, page, "tstv1-second");
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
          ids[0],
        );
      }
      expect(
        (await state.product("tasks.list", { directory: state.directory }))
          .sort((a, b) => a.order - b.order).map((t) => t.id),
      ).toEqual([exec.id, plan.id]);
      await openSession(state, page, "tstv1-otk");
      await activity(state, "tstv1-helper", "release");
      await activity(state, "tstv1-nested", "release");
      // D72: both human acknowledgement and parent delivery retire a finish.
      const helper = "tstv1-helper", nested = "tstv1-nested";
      const helpers = page.locator(
        `[data-session=${helper}], [data-session=${nested}]`,
      );
      await expect(helpers.locator(".otk-status-light[data-state=finished]"))
        .toHaveCount(2);
      await expect(page.locator(
        "[data-crumb=tstv1-helper], [data-crumb=tstv1-nested]",
      )).toHaveCount(0);
      const pill = page.getByRole("button", { name: /^Subagents:/ });
      await expect(pill).toHaveAccessibleName("Subagents: 2 finished");
      await pill.click();
      const menu = page.getByRole("menu", { name: "Subagents" });
      const agent = (id: string) => menu.locator(`[data-subagent=${id}]`);
      await expect(agent(helper)).toBeVisible();
      await expect(agent(nested)).toBeVisible();
      const finishes = await state.product("sessions.finishes", {});
      await state.product("sessions.seen", {
        sessionID: helper,
        terminal: finishes[helper],
      });
      await expect(pill).toHaveAccessibleName("Subagents: 1 finished");
      await expect(agent(helper)).toHaveCount(0);
      await expect(agent(nested)).toBeVisible();
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "release",
        target: "trail-delivery",
        sessionID: nested,
      });
      await expect(helpers.locator(".otk-status-light[data-state=finished]"))
        .toHaveCount(0);
      await expect(pill).toHaveCount(0);
      await expect(menu.locator("[data-subagent]")).toHaveCount(0);
      await expect(
        page.locator("[data-tab=tstv1-helper], [data-tab=tstv1-nested]"),
      )
        .toHaveCount(0);
      await page.locator(".otk-new-session").click();
      await expect(page.locator("[data-crumb]")).toHaveCount(1);
      await expect.poll(async () =>
        (await state.product("tasks.list", { directory: state.directory }))
          .find((t) => t.id === exec.id)!.sessions
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
    for (const id of ids.slice(1)) await activity(state, id, "hold");
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.goto(`${state.url}/#/local/tstv1-otk/tstv1-chain-8`);
    const chip = page.getByRole("button", {
      name: /^Subagents:/,
    });
    await expect(chip).toBeVisible();
    await expect(page.locator("[data-crumb]:visible")).toHaveCount(10);
    await expect(page.locator("[data-fit-mode]").first()).toHaveAttribute(
      "data-fit-mode",
      "compact",
    );
    await chip.click();
    const choice = page.locator(".otk-subagents [data-subagent]")
      .nth(1);
    const id = await choice.getAttribute("data-subagent");
    expect(ids).toContain(id);
    await choice.locator(".otk-subagent-name").click();
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
    await chip.click();
    await expect(page.locator(`[data-subagent="${id}"] .otk-lamp-shape`))
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
        "normal",
      );
      await expect(page.locator("[data-tab=tstv1-preview-b]")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.locator("[data-tab=tstv1-otk]")).toHaveAttribute(
        "aria-selected",
        "false",
      );
      await expect(page.locator("[data-tab=tstv1-otk]")).toHaveCSS(
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
      await state.product("sessions.seen", {
        sessionID: "tstv1-otk",
        terminal: (await state.product("sessions.finishes", {}))["tstv1-otk"] ??
          0,
      });
      await page.locator(`[data-tab="${task.id}"]`).click();
      await expect(page.locator("[data-tab=tstv1-otk]")).toHaveCount(0);
      expect(await state.product("session.get", { sessionID: "tstv1-otk" }))
        .toBeTruthy();
    },
  );
});
