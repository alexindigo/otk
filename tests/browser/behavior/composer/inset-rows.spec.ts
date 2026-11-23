// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { sessionContext } from "../../pages/sessions.ts";
import { prompt, questions, reply, seed, tool } from "../../pages/attention.ts";

test.describe("composer notice inset", () => {
  test.use({ profile: "revert-native" });
  test("composer.joined-notice-borrows-input-content-edges", {
    tag: ["@composer", "@contracts", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    const session = await seed(state, "Fork inset");
    await openSession(state, page, session.id);
    await state.queue(["Fork inset reply"]);
    await prompt(page, "A prompt to fork");
    await reply(page, session.id, "Fork inset reply");
    await sessionContext(
      page,
      `[data-session="${session.id}"]`,
      "session.fork",
    );
    await expect(page.locator(".otk-fork-note")).toBeVisible();
    for (const width of [1440, 760]) {
      await page.setViewportSize({ width, height: 900 });
      await state.product("layout.patch", {
        leftCollapsed: width === 760,
        rightCollapsed: width === 760,
      });
      await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
        "data-collapsed",
        String(width === 760),
      );
      for (const scale of ["100", "125"]) {
        await state.product("prefs.set", { key: "textSize", value: scale });
        await expect(page.locator("html")).toHaveCSS(
          "--otk-scale",
          String(Number(scale) / 100),
        );
        const edges = await page.locator(".otk-composer-dock").evaluate(
          (dock) => {
            const box = (selector: string) =>
              dock.querySelector(selector)!.getBoundingClientRect();
            const notice = box(".otk-composer-notice-row");
            return {
              left: Math.abs(notice.left - box(".otk-prompt-input").left),
              right: Math.abs(notice.right - box(".otk-send-button").right),
            };
          },
        );
        expect(edges.left).toBeLessThanOrEqual(1);
        expect(edges.right).toBeLessThanOrEqual(1);
      }
    }
    await page.screenshot({
      path: info.outputPath("composer-inset-notice.png"),
      fullPage: true,
      animations: "disabled",
    });
  });
});

test.describe("composer takeover inset", () => {
  test.use({ profile: "contract-attention-native" });
  test("composer.dock-title-body-and-actions-borrow-one-content-inset", {
    tag: ["@composer", "@attention", "@contracts", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    const session = await seed(state, "Composer inset");
    await openSession(state, page, session.id);
    await tool(state, "read", { filePath: `${state.directory}/README.md` });
    await prompt(page, "Read the fixture");
    await expect(page.locator(".otk-permission-dock")).toBeVisible();
    const check = async () => {
      const edges = await page.locator(".otk-composer-dock").evaluate(
        (dock) => {
          const box = (selector: string) =>
            dock.querySelector(selector)!.getBoundingClientRect();
          const target = box(".otk-composer-target");
          const row = dock.querySelector(".otk-composer-activity")!,
            rowStyle = getComputedStyle(row);
          const right = row.getBoundingClientRect().right -
            parseFloat(rowStyle.paddingRight) -
            parseFloat(rowStyle.borderRightWidth);
          const surface = dock.querySelector(
            ".otk-composer-takeover-layer .otk-takeover > .otk-surface",
          )!;
          return [
            ".otk-surface-title",
            ".otk-surface-body",
            ".otk-surface-actions",
          ].map((selector) => {
            const node = surface.querySelector(selector)!,
              r = node.getBoundingClientRect(),
              css = getComputedStyle(node);
            return {
              selector,
              left: Math.abs(
                r.left + parseFloat(css.paddingLeft) - target.left,
              ),
              right: Math.abs(r.right - parseFloat(css.paddingRight) - right),
            };
          });
        },
      );
      for (const edge of edges) {
        expect(edge.left, edge.selector).toBeLessThanOrEqual(1);
        expect(edge.right, edge.selector).toBeLessThanOrEqual(1);
      }
    };
    for (const width of [1440, 760]) {
      await page.setViewportSize({ width, height: 900 });
      await state.product("layout.patch", {
        leftCollapsed: width === 760,
        rightCollapsed: width === 760,
      });
      await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
        "data-collapsed",
        String(width === 760),
      );
      for (const scale of ["100", "125"]) {
        await state.product("prefs.set", { key: "textSize", value: scale });
        await expect(page.locator("html")).toHaveCSS(
          "--otk-scale",
          String(Number(scale) / 100),
        );
        await check();
      }
    }
    await page.screenshot({
      path: info.outputPath("composer-inset-permission.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await page.getByRole("button", { name: "Reject request", exact: true })
      .click();
    await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
    await tool(state, "question", { questions: [questions[0]] });
    await prompt(page, "Ask the fixture question");
    await expect(page.locator(".otk-question-dock")).toBeVisible();
    await check();
    await page.screenshot({
      path: info.outputPath("composer-inset-question.png"),
      fullPage: true,
      animations: "disabled",
    });
  });
});
