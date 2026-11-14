// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-visual-styles" });
const themes = ["otk-dark", "otk-light", "otk-light-stone"];
async function boxes(controls: Locator[]) {
  return await Promise.all(controls.map((control) =>
    control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    })
  ));
}
function unchanged(before: number[][], after: number[][]) {
  expect(after.length).toBe(before.length);
  for (let index = 0; index < before.length; index++) {
    for (let axis = 0; axis < 4; axis++) {
      expect(Math.abs(after[index][axis] - before[index][axis]))
        .toBeLessThanOrEqual(1);
    }
  }
}
for (const theme of themes) {
  for (const field of ["", "taskName"]) {
    test(
      `menus.structured-dialog-controls-stay-fixed-${
        field || "action"
      }-${theme}`,
      { tag: ["@menus", "@isolated", "@visual"] },
      async ({ isolatedState: state, page }, info) => {
        await page.goto(
          `${state.url}/?scene=feedback-stability&surface=dialog`,
        );
        await page.evaluate(`styleTest.theme(${JSON.stringify(theme)})`);
        const dialog = page.getByRole("dialog", {
          name: "New task",
          exact: true,
        });
        const controls = [
          dialog.locator("h2"),
          dialog.locator('input[name="taskName"]'),
          dialog.locator('input[name="description"]'),
          dialog.locator(".otk-action-slot"),
        ];
        const idle = await boxes(controls);
        await dialog.getByRole("button", { name: "Save task", exact: true })
          .click();
        await expect(dialog.locator("form")).toHaveAttribute(
          "aria-busy",
          "true",
        );
        unchanged(idle, await boxes(controls));
        await page.evaluate(`styleTest.fieldFailure(${JSON.stringify(field)})`);
        const alert = dialog.getByRole("alert");
        await expect(alert).toHaveCount(1);
        await expect(alert).toContainText("END OF REASON");
        unchanged(idle, await boxes(controls));
        await expect(controls[1]).toHaveValue("Retained task name");
        await expect(controls[2]).toHaveValue("Retained description");
        const failure = await alert.boundingBox(),
          action = await controls[3].boundingBox();
        expect(failure!.y).toBeGreaterThanOrEqual(action!.y + action!.height);
        if (field) {
          const id = await controls[1].getAttribute("aria-describedby");
          await expect(page.locator(`[id="${id}"]`)).toContainText(
            "END OF REASON",
          );
          await info.attach(`stable-dialog-${theme}`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
        }
      },
    );
  }
  test(`menus.structured-inline-controls-stay-fixed-${theme}`, {
    tag: ["@menus", "@isolated", "@visual"],
  }, async ({ isolatedState: state, page }, info) => {
    await page.goto(`${state.url}/?scene=feedback-stability&surface=inline`);
    await page.evaluate(`styleTest.theme(${JSON.stringify(theme)})`);
    const input = page.getByRole("textbox", {
      name: "Rename session",
      exact: true,
    });
    await input.fill("Retained edited name");
    const controls = [
      input,
      page.getByRole("button", { name: "Session actions", exact: true }),
    ];
    const idle = await boxes(controls);
    await input.press("Enter");
    await expect(input).toHaveAttribute("aria-busy", "true");
    unchanged(idle, await boxes(controls));
    await page.evaluate('styleTest.fieldFailure("")');
    await expect(page.getByRole("alert")).toContainText("END OF REASON");
    unchanged(idle, await boxes(controls));
    await expect(input).toHaveValue("Retained edited name");
    await info.attach(`stable-inline-${theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
  for (const surface of ["composer", "standalone", "rollback"]) {
    test(`menus.structured-${surface}-controls-stay-fixed-${theme}`, {
      tag: ["@menus", "@isolated", "@visual"],
    }, async ({ isolatedState: state, page }, info) => {
      await page.goto(
        `${state.url}/?scene=feedback-stability&surface=${surface}`,
      );
      await page.evaluate(`styleTest.theme(${JSON.stringify(theme)})`);
      if (surface !== "standalone") {
        await page.evaluate(
          'styleTest.settleNotice(); styleTest.feedback("clear")',
        );
      }
      const input = page.locator('textarea[name="prompt"]'),
        primary = page.locator("[data-primary-action]");
      await input.fill("Retained prompt draft");
      const controls = [input, primary];
      if (surface !== "standalone") {
        controls.push(
          page.getByRole("button", { name: "Restore", exact: true }),
        );
      }
      const idle = await boxes(controls);
      if (surface !== "standalone") {
        await page.evaluate('styleTest.feedback("pending")');
      } else await primary.click();
      await expect(page.getByRole("status")).toBeVisible();
      unchanged(idle, await boxes(controls));
      await page.evaluate(
        surface === "rollback"
          ? 'styleTest.feedback("clear"); styleTest.failRollback()'
          : surface === "composer"
          ? 'styleTest.feedback("error")'
          : 'styleTest.fieldFailure("")',
      );
      await expect(page.getByRole("alert")).toContainText("END OF REASON");
      unchanged(idle, await boxes(controls));
      await expect(input).toHaveValue("Retained prompt draft");
      if (surface === "composer") {
        await info.attach(`stable-composer-${theme}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      }
    });
  }
  test(`menus.structured-auth-controls-stay-fixed-${theme}`, {
    tag: ["@menus", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await page.goto(`${state.url}/?scene=feedback-stability&surface=auth`);
    await page.evaluate(`styleTest.theme(${JSON.stringify(theme)})`);
    const controls = [
      page.locator(".otk-auth-column h1"),
      page.locator('input[name="taskName"]'),
      page.locator('input[name="description"]'),
      page.locator(".otk-action-slot"),
    ];
    const idle = await boxes(controls);
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await expect(page.locator("form")).toHaveAttribute("aria-busy", "true");
    unchanged(idle, await boxes(controls));
    await page.evaluate('styleTest.fieldFailure("taskName")');
    await expect(page.getByRole("alert")).toContainText("END OF REASON");
    unchanged(idle, await boxes(controls));
  });
}
