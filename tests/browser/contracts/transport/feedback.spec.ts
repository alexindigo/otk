// SPDX-License-Identifier: LGPL-3.0-only
import {
  expectPrimaryBlocked,
  expectRuleThree,
} from "../../pages/primary-action.ts";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, throughDuration, wire } from "../../fixtures/wire.ts";

for (const kind of ["permission", "question"] as const) {
  test.describe(kind, () => {
    test.use({
      profile: kind === "permission"
        ? "contract-permission-feedback"
        : "contract-question-feedback",
    });
    test(`transport.${kind}-feedback`, {
      tag: ["@transport", "@contracts", "@isolated", "@attention"],
    }, async ({ isolatedState: state, page }) => {
      await state.product("prefs.set", { key: "animationsOff", value: true });
      await page.goto(`${state.url}/#/local/tstv1-core`);
      const dock = page.locator(`.otk-${kind}-dock`);
      await expect(dock).toBeVisible();
      if (kind === "question") {
        await page.locator("textarea[name=question-answer]").fill(
          "Keep my own answer",
        );
      }
      const submit = kind === "permission"
        ? page.locator(".otk-permission-actions button").first()
        : page.locator(".otk-question-submit");
      await submit.click();
      const pending = page.locator(
        ".otk-takeover-notice .otk-operation-feedback.is-pending",
      );
      await expect(pending).toBeVisible();
      await expect(pending).toBeFocused();
      await expect(page.locator(".otk-composer-notice")).toHaveCount(1);
      await expectRuleThree(dock);
      await expectPrimaryBlocked(
        dock.locator("[data-primary-action]"),
        kind === "permission" ? "Sending response" : "Sending answer",
      );
      await expect(dock.locator(".otk-field-feedback")).toHaveCount(0);
      expect(
        await dock.locator(
          ".otk-permission-actions button:not([data-primary-action]),.otk-question-actions button:not([data-primary-action]),.otk-question-options button,textarea",
        ).evaluateAll((elements) =>
          elements.filter((el) =>
            el.getClientRects().length &&
            getComputedStyle(el).visibility !== "hidden" &&
            !(el as HTMLTextAreaElement).readOnly
          ).length
        ),
      ).toBe(0);
      await expect(
        dock.getByRole("status").filter({
          hasText: /Sending (response|answer)/,
        }),
      ).toHaveCount(1);
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "release",
      });
      await expect(page.locator(".otk-takeover-notice [role=alert]"))
        .toBeVisible();
      await expect(page.locator("[role=alert]:visible")).toHaveCount(1);
      if (kind === "question") {
        await expect(page.locator("textarea[name=question-answer]"))
          .toHaveValue("Keep my own answer");
      }
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "succeed",
      });
      await submit.click();
      await expect(pending).toBeVisible();
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "release",
      });
      await expect(dock).toHaveCount(0);
      expect((await state.observe<{ calls: number }>()).calls).toBe(2);
    });
  });
}

test.describe("long task", () => {
  test.use({ profile: "contract-task-pending" });
  test("transport.forty-second-task", {
    tag: ["@transport", "@contracts", "@isolated", "@duration"],
  }, async ({ isolatedState: state, page }, info) => {
    test.setTimeout(120_000);
    const frames = await wire(page);
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await page.locator(".otk-task-new").click();
    await page.locator('input[name="taskName"]').fill("perf");
    await page.locator('.otk-form button[type="submit"]').click();
    await expect.poll(async () =>
      (await state.observe<{ calls: number }>()).calls
    ).toBe(1);
    const form = page.locator(".otk-form");
    await expect(form).toHaveAttribute("aria-busy", "true");
    const bounds = await form.boundingBox();
    const observations: unknown[] = [], start = performance.now();
    const inspect = async () => {
      await expect(form).toHaveAttribute("aria-busy", "true");
      await expect(form).toContainText("Creating task");
      await expect(form.locator("input[name=taskName]")).toHaveJSProperty(
        "readOnly",
        true,
      );
      await expect(form.locator("input[name=taskName]")).toHaveValue("perf");
      await expect(form.locator("[role=alert],[disabled],[aria-disabled=true]"))
        .toHaveCount(0);
      expect(await form.boundingBox()).toEqual(bounds);
      expect(await state.product("tasks.list", { directory: state.directory }))
        .toEqual([]);
      observations.push({ elapsed: performance.now() - start, bounds });
    };
    await throughDuration(16_000, inspect);
    await form.evaluate((element) =>
      (element as HTMLFormElement).requestSubmit()
    );
    frames.close();
    await expect.poll(() =>
      frames.sent.some(({ frame }) => frame.t === "request.resume")
    ).toBe(true);
    await throughDuration(
      Math.max(0, 40_000 - (performance.now() - start)),
      inspect,
    );
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
    });
    await expect(page.locator("input[name=taskName]")).toHaveCount(0);
    const tasks = await state.product("tasks.list", {
      directory: state.directory,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("perf");
    await expect(page.locator(`[data-tab="${tasks[0].id}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect((await state.observe<{ calls: number }>()).calls).toBe(1);
    expect(
      frames.sent.filter(({ frame }) =>
        frame.t === "request" && frame.method === "tasks.create"
      ),
    ).toHaveLength(1);
    await info.attach("elapsed-task-contract", {
      body: JSON.stringify({
        observations,
        elapsed: performance.now() - start,
        task: tasks[0],
      }),
      contentType: "application/json",
    });
  });
});

test.describe("background task", () => {
  test.use({ profile: "contract-task-background" });
  test("transport.background-task", {
    tag: ["@transport", "@contracts", "@isolated", "@attention"],
  }, async ({ isolatedState: state, page }) => {
    const { entries } = await state.observe<
      { entries: { directory: string }[] }
    >();
    await page.goto(`${state.url}/#/local/tstv1-otk`);
    await page.locator(".otk-task-new").click();
    await page.locator("input[name=taskName]").fill("Background perf");
    await page.locator('.otk-form button[type="submit"]').click();
    await expect(page.locator(".otk-form")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await page.locator('dialog[open] button[aria-label^="Close "]').click();
    await openSession(state, page, "tstv1-globnotes");
    await state.product("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
    const project = page.locator(`[data-project="${entries[0].directory}"]`);
    const inspect = async () => {
      await expect(project).toHaveAttribute("data-rollup", "working");
      await expect(project).toBeInViewport({ ratio: 1 });
      await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
        "data-collapsed",
        "true",
      );
      await expect(page.locator(".otk-right-panel")).toBeHidden();
    };
    await inspect();
    await page.reload();
    await inspect();
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
    });
    await expect(project).toHaveAttribute("data-rollup", "none");
    expect(
      (await state.product("tasks.list", { directory: entries[0].directory }))
        .map((task) => task.name),
    ).toEqual(["Background perf"]);
    expect((await state.observe<{ calls: number }>()).calls).toBe(1);
  });
});
