// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { readyMenuBox } from "../../pages/menus.ts";
import { expandedFailure } from "../../pages/failure-geometry.ts";
test.use({ profile: "contract-visual-styles" });
const tags = { tag: ["@visual", "@isolated"] };
async function scene(page: Page, url: string, name: string) {
  await page.goto(url + "/?scene=" + name);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await page.evaluate("styleTest.theme('otk-dark')");
  await expect(page.locator("html")).toHaveAttribute(
    "data-otk-theme",
    "otk-dark",
  );
}
const bounds = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  });
test(
  "visual.notice-publication-retains-disclosure-node-and-restore",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "notice-lifetime");
    await page.evaluate("styleTest.resetNotice()");
    const restores = Number(
      await page.locator("[data-restores]").getAttribute("data-restores"),
    );
    const strip = page.locator(".otk-revert-group"),
      original = await strip.elementHandle();
    const disclosure = page.locator(
      ".otk-revert-group .otk-record-group-toggle",
    );
    await page.evaluate("styleTest.settleNotice()");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".otk-revert-restore")).toBeVisible();
    if (
      await disclosure.getAttribute("aria-expanded") !== "true"
    ) await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    for (
      const operation of [
        "refreshNotice()",
        "settleNotice()",
        "feedback('pending')",
        "feedback('error')",
        "feedback('clear')",
      ]
    ) {
      await page.evaluate("styleTest." + operation);
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      expect(await strip.evaluate((el, old) => el === old, original)).toBe(
        true,
      );
      await expect(page.locator(".otk-composer-notice")).toHaveCount(
        operation === "feedback('pending')" || operation === "feedback('error')"
          ? 1
          : 0,
      );
      if (operation !== "refreshNotice()") {
        await expect(page.locator(".otk-revert-restore"))
          .toBeAttached();
      }
    }
    await page.locator(".otk-revert-restore").click();
    await expect(page.locator("[data-restores]")).toHaveAttribute(
      "data-restores",
      String(restores + 1),
    );
  },
);
test(
  "visual.feedback-owner-replacement-release-and-remount",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "feedback-owners");
    await page.evaluate(
      "styleTest.mountFeedback(true);styleTest.feedbackOwner(0);styleTest.emitFeedback(0,'pending')",
    );
    const subscriptions = page.locator("[data-owner-subscriptions]");
    await expect(subscriptions).toHaveAttribute(
      "data-owner-subscriptions",
      "1,0",
    );
    await expect(page.getByRole("status")).toHaveText("Original target");
    await page.evaluate(
      "styleTest.feedbackOwner(1);styleTest.emitFeedback(1,'connection')",
    );
    await expect(subscriptions).toHaveAttribute(
      "data-owner-subscriptions",
      "0,1",
    );
    await expect(page.locator(".is-reconnecting")).toHaveText(
      "Replacement target",
    );
    await page.evaluate("styleTest.emitFeedback(0,'error')");
    await expect(page.locator(".otk-feedback-status")).toHaveText(
      "Replacement target",
    );
    await page.evaluate("styleTest.mountFeedback(false)");
    await expect(subscriptions).toHaveAttribute(
      "data-owner-subscriptions",
      "0,0",
    );
    await page.evaluate(
      "styleTest.feedbackOwner(0);styleTest.mountFeedback(true)",
    );
    await expect(subscriptions).toHaveAttribute(
      "data-owner-subscriptions",
      "1,0",
    );
    await expect(page.getByRole("alert")).toHaveAccessibleName(
      "Original target",
    );
    await expect(page.getByRole("alert").locator(".otk-failure-reason"))
      .toHaveText("Original target");
    await page.evaluate("styleTest.mountFeedback(false)");
    await expect(subscriptions).toHaveAttribute(
      "data-owner-subscriptions",
      "0,0",
    );
  },
);
test(
  "visual.theme-keymap-pending-safe-failure-and-focus",
  tags,
  async ({ isolatedState: state, page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await scene(page, state.url, "preference-feedback");
    await page.locator('[data-theme-choice="otk-dark"]').click();
    for (const name of ["theme", "keys"]) {
      const surface = page.locator(`[data-preference-surface=${name}]`),
        before = await bounds(page, `[data-preference-surface=${name}]`);
      await surface.getByRole("button", {
        name: name === "theme" ? "Save theme" : "Reset all shortcuts",
        exact: true,
      }).click();
      await expect(surface.locator("[disabled],[aria-disabled=true]"))
        .toHaveCount(0);
      await expect(surface.getByRole("status")).not.toHaveText("");
      await expect(surface.getByRole("status")).toBeFocused();
      await page.evaluate("styleTest.settlePreference()");
      await expect(surface.getByRole("alert")).not.toHaveText("");
      await expandedFailure(page, `[data-preference-surface=${name}]`, before);
      await page.evaluate("styleTest.settlePreference()");
    }
  },
);
test(
  "visual.form-captures-once-readonly-retained-values-safe-error",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "forms");
    const before = await bounds(page, ".otk-form"),
      calls = Number(
        await page.locator("[data-form-calls]").getAttribute("data-form-calls"),
      );
    await page.locator("form").evaluate((el) => {
      (el as HTMLFormElement).requestSubmit();
      (el as HTMLFormElement).requestSubmit();
    });
    await expect(page.locator("[data-form-calls]")).toHaveAttribute(
      "data-form-calls",
      String(calls + 1),
    );
    await expect(
      page.locator(".otk-form [disabled],.otk-form [aria-disabled=true]"),
    ).toHaveCount(0);
    await expect(page.locator("input").first()).toHaveAttribute("readonly", "");
    await expect(page.locator("input").first()).toHaveValue("perf");
    expect(await bounds(page, ".otk-form")).toEqual(before);
    await page.evaluate("styleTest.feedback('error')");
    await expect(page.getByRole("alert")).not.toHaveText("");
    await expandedFailure(page, ".otk-form", before);
    await expect(page.locator("body")).not.toContainText("/secret/path");
    await expect(page.locator("input").first()).not.toHaveAttribute("readonly");
  },
);
test(
  "visual.native-field-feedback-accessible-descriptions-and-retained-text",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "forms");
    for (const name of ["notes", "kind"]) {
      const field = page.locator(
        name === "notes" ? 'textarea[name="notes"]' : 'button[name="kind"]',
      );
      const before = await bounds(page, ".otk-form");
      await page.locator(".otk-form button[type=submit]").click();
      await expect(page.locator(".otk-form")).toHaveAttribute(
        "aria-busy",
        "true",
      );
      await expect(page.getByRole("status")).toBeFocused();
      await expect(page.locator("textarea")).toHaveAttribute("readonly", "");
      await expect(page.locator(".otk-select-value")).toHaveValue("Alpha");
      await page.evaluate(`styleTest.fieldFailure('${name}')`);
      await expect(field).toHaveAttribute("aria-invalid", "true");
      const description = await field.evaluate((el) => {
        const ids = el.getAttribute("aria-describedby")!.split(" ");
        return {
          ids,
          errors: ids.map((id) =>
            document.getElementById(id)
          ).filter((e) => e?.getAttribute("role") === "alert").length,
        };
      });
      expect(description.errors).toBe(1);
      if (name === "notes") expect(description.ids).toContain("notes-help");
      await expect(page.getByRole("alert")).toHaveText(
        /OTK has no further details/,
      );
      await expandedFailure(page, ".otk-form", before);
      await expect(page.locator("textarea")).toHaveValue("Keep this text");
    }
  },
);
test(
  "visual.request-feedback-reserves-field-track-and-centres-content",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "requests");
    for (const width of [1280, 800]) {
      await page.setViewportSize({ width, height: 700 });
      let baseline: number[][] | undefined;
      for (const feedback of ["clear", "pending", "error"]) {
        await page.evaluate(`styleTest.feedback('${feedback}')`);
        const g = await page.evaluate(() => {
          const rect = (el: Element) => {
            const r = el.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          };
          const pane = document.querySelector(".request-feedback-pane")!;
          const content = pane.querySelector(".otk-pane-state-content")!;
          const operation = document.querySelector(".otk-operation-feedback")!;
          return {
            boxes: [
              rect(document.querySelector(".request-feedback-form input")!),
              rect(document.querySelector("#task-feedback")!),
            ],
            pane: rect(pane),
            content: rect(content),
            centres: Array.from(operation.children).map((el) => {
              const r = el.getBoundingClientRect();
              return r.y + r.height / 2;
            }),
            disabled:
              document.querySelectorAll('[disabled],[aria-disabled="true"]')
                .length,
            colour: getComputedStyle(operation).color,
            signal: operation.querySelector(".otk-failure-signal")
              ? getComputedStyle(
                operation.querySelector(".otk-failure-signal")!,
              ).boxShadow
              : undefined,
          };
        });
        expect(g.disabled).toBe(0);
        expect(
          Math.abs(g.pane[0] + g.pane[2] / 2 - g.content[0] - g.content[2] / 2),
        ).toBeLessThan(1);
        expect(
          Math.abs(g.pane[1] + g.pane[3] / 2 - g.content[1] - g.content[3] / 2),
        ).toBeLessThan(1);
        expect(Math.max(...g.centres) - Math.min(...g.centres)).toBeLessThan(1);
        if (feedback === "clear") baseline = g.boxes;
        else {
          expect(g.boxes[0]).toEqual(baseline![0]);
          // Structured facts grow within the feedback's normal-flow track;
          // its origin/width and the concerned input do not shift.
          expect(g.boxes[1].slice(0, 3)).toEqual(baseline![1].slice(0, 3));
          expect(g.boxes[1][3]).toBeGreaterThanOrEqual(baseline![1][3]);
        }
        if (feedback === "error") {
          // Failure content keeps foreground text; its shared signal owns danger.
          expect(g.colour).toBe("rgb(230, 234, 239)");
          expect(g.signal).toBe("rgb(255, 128, 128) 2px 0px 0px 0px inset");
        }
      }
    }
  },
);
test(
  "visual.command-menu-pending-focus-and-one-safe-failure",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "lists");
    await page.evaluate("styleTest.holdMenu(true)");
    await page.getByRole("button", { name: "Reactive list menu", exact: true })
      .click();
    const panel = page.locator(":popover-open"),
      action = panel.locator('[data-context-command="list.one"]');
    const before = await readyMenuBox(panel, ["one", "two", "delete"]);
    await action.focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("status")).not.toHaveText("");
    await expect(panel.getByRole("status")).toBeFocused();
    await expect(panel.getByRole("menuitem")).toHaveCount(0);
    await expect(panel.locator("[disabled],[aria-disabled=true]")).toHaveCount(
      0,
    );
    expect((await panel.boundingBox())!.width).toBe(before.width);
    expect((await panel.boundingBox())!.height).toBe(before.height);
    await page.evaluate("styleTest.settleMenu(true)");
    await expect(panel.getByRole("alert")).toHaveText(
      /OTK has no further details/,
    );
    await expect(panel.getByRole("alert")).toHaveCount(1);
    await expect(action).toBeFocused();
    expect((await panel.boundingBox())!.width).toBe(before.width);
    const feedbackHeight = await panel.getByRole("alert").evaluate((el) =>
      el.getBoundingClientRect().height +
      parseFloat(getComputedStyle(el.parentElement!).rowGap)
    );
    expect((await panel.boundingBox())!.height).toBe(
      before.height + feedbackHeight,
    );
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await page.evaluate("styleTest.holdMenu(false)");
  },
);
test(
  "visual.keyed-crumbs-and-menu-rows-replace-shrink-without-adoption",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "lists");
    const ids = Array.from({ length: 10 }, (_, i) => `session-${i}`);
    await page.evaluate(
      `styleTest.lists(${JSON.stringify(ids)},'session-9','session-7')`,
    );
    await expect(page.locator('[data-crumb="session-7"] input')).toHaveValue(
      "session-7",
    );
    const original = await page.locator('[data-crumb="session-9"]')
      .elementHandle();
    const otherOriginal = await page.locator('[data-crumb="session-1"]')
      .elementHandle();
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(page.locator(".otk-subagents > button")).toBeVisible();
    const visible = () =>
      page.locator("[data-crumb]").evaluateAll((els) =>
        els.filter((el) => !el.closest("[hidden]")).map((el) =>
          el.getAttribute("data-crumb")!
        )
      );
    const shown = await visible();
    expect(shown).toContain("session-9");
    expect(shown).toContain("session-7");
    expect(shown).toEqual(ids);
    expect(shown).toEqual(ids.filter((id) => shown.includes(id)));
    expect(
      await page.locator('[data-crumb="session-9"]').evaluate(
        (el, old) => el === old,
        original,
      ),
    ).toBe(true);
    expect(
      await page.locator('[data-crumb="session-1"]').evaluate(
        (el, old) => el === old,
        otherOriginal,
      ),
    ).toBe(true);
    // D67 moved the helper menu out of this row. The row's existing Session
    // control still proves that ending an editor cannot move its press target.
    const sessionBefore = await bounds(page, ".otk-new-session");
    await page.locator(".otk-new-session").click();
    await expect.poll(() => page.evaluate("styleTest.createdSessions()"))
      .toBe(1);
    expect(
      (await bounds(page, ".otk-new-session")).every((value, index) =>
        Math.abs(value - sessionBefore[index]) <= 1
      ),
    ).toBe(true);
    const before = await bounds(page, ".otk-subagents > button");
    await page.locator(".otk-subagents > button").click();
    await expect(page.locator(".otk-subagents [role=menuitem]").first())
      .toBeVisible();
    expect(
      (await bounds(page, ".otk-subagents > button")).every((v, i) =>
        Math.abs(v - before[i]) <= 1
      ),
    ).toBe(true);
    const omitted = await page.locator(
      ".otk-subagents [data-subagent]",
    ).evaluateAll((els) => els.map((el) => el.getAttribute("data-subagent")));
    // D67 keeps every ancestor; the composer inventory is independent.
    const currentShown = await visible();
    expect(omitted).toEqual(ids.slice(1));
    expect(
      ids.filter((id) => !currentShown.includes(id)).every((id) =>
        omitted.includes(id)
      ),
    ).toBe(true);
    expect(
      await page.locator("[data-subagent]").evaluateAll((els) =>
        els.every((el) => !el.closest("[data-overflow-key]"))
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await page.evaluate("styleTest.lists(['replacement'],'replacement')");
    await expect(page.locator("[data-crumb]")).toHaveCount(1);
    await expect(page.locator('[data-crumb="replacement"]')).toBeAttached();
    await page.evaluate("styleTest.lists([])");
    await expect(page.locator("[data-crumb]")).toHaveCount(0);
    await page.evaluate(
      `styleTest.lists(${JSON.stringify(ids.slice().reverse())},'session-4')`,
    );
    await page.getByRole("button", { name: "Reactive list menu", exact: true })
      .click();
    await expect(page.locator(":popover-open [role=menuitem]")).toHaveCount(3);
    await page.evaluate("styleTest.menuItems(['delete'])");
    await expect(page.locator(":popover-open [role=menuitem]")).toHaveCount(1);
    await expect(page.locator(":popover-open [role=menuitem]")).toHaveAttribute(
      "data-context-command",
      "list.delete",
    );
    await expect(page.locator(":popover-open [role=group] [role=separator]"))
      .toHaveCount(1);
    await page.evaluate("styleTest.menuItems(['one','two','delete'])");
    await expect(page.locator(":popover-open [role=menuitem]")).toHaveCount(3);
  },
);
test(
  "visual.trail-first-words-retain-measured-width-inside-the-shared-scroll-lane",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "lists");
    const root = "root" + "w".repeat(100);
    await page.setViewportSize({ width: 600, height: 800 });
    await page.evaluate(
      `styleTest.lists(${JSON.stringify([root, "leaf"])},'leaf')`,
    );
    const trail = page.locator(".otk-task-crumbs");
    await expect(trail.locator("[data-fit-mode]")).toHaveAttribute(
      "data-fit-mode",
      "compact",
    );
    await expect(trail.locator("[data-crumb]")).toHaveCount(2);
    await expect.poll(() =>
      trail.locator(".otk-trail-first:visible").evaluateAll((nodes) =>
        nodes.every((node) => {
          const word = node.getBoundingClientRect(),
            frame = node.closest("[data-overflow-key]")!
              .getBoundingClientRect();
          return word.width > 0 && word.left >= frame.left &&
            word.right <= frame.right;
        })
      )
    ).toBe(true);
    await expect.poll(() =>
      trail.locator(".otk-overflow-items").evaluate((lane) =>
        lane.scrollWidth > lane.clientWidth
      )
    ).toBe(true);
    await expect(trail.getByRole("scrollbar", { name: "Horizontal scroll" }))
      .toBeAttached();
  },
);
test(
  "visual.blocks-own-prose-and-explicit-concealment",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "prose");
    await page.evaluate("styleTest.conceal(false)");
    const values = await page.evaluate(() =>
      ["standalone", "reasoning", "textpart"].map((id) => {
        const root = document.getElementById(id)!,
          p = root.querySelector("p")!,
          code = p.querySelector("code")!,
          strong = p.querySelector("strong")!;
        return {
          font: getComputedStyle(p).fontSize,
          line: getComputedStyle(p).lineHeight,
          code: getComputedStyle(code).backgroundColor,
          mark: getComputedStyle(strong, "::before").content,
          nested:
            getComputedStyle(root.querySelector("blockquote")!).borderLeftWidth,
          pre: getComputedStyle(root.querySelector("pre")!).lineHeight,
        };
      })
    );
    for (const value of values) {
      expect(value.font).toBe("14px");
      expect(value.line).toBe("24px");
      expect(value.mark).toBe('"**"');
      expect(value.nested).toBe("2px");
      expect(value.pre).toBe("20px");
    }
    expect(values[0]).toEqual(values[1]);
    expect(values[0]).toEqual(values[2]);
    expect(
      await page.locator("#standalone pre").evaluate((el) =>
        getComputedStyle(el, "::before").content
      ),
    ).toBe('"```"');
    await page.evaluate(
      "styleTest.conceal(true);document.body.classList.add('otk-unconcealed')",
    );
    for (
      const selector of [
        "#standalone strong",
        "#textpart strong",
        "#standalone pre",
      ]
    ) {
      await expect.poll(() =>
        page.locator(selector).evaluate((el) =>
          getComputedStyle(el, "::before").content
        )
      ).toBe("none");
    }
  },
);
test(
  "visual.permission-summary-styles-independent-of-journal",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "journal");
    for (
      const toggle of await page.locator(".otk-permission-scope").all()
    ) await toggle.click();
    const values = await page.evaluate(() =>
      ["summary", "activity"].map((id) =>
        Array.from(document.getElementById(id)!.querySelectorAll(
          ".otk-permission-summary li",
        )).map((el) => {
          const s = getComputedStyle(el);
          return [
            s.display,
            s.paddingBottom,
            s.borderBottomWidth,
            s.flexDirection,
            s.listStyleType,
            el.getBoundingClientRect().height,
          ];
        })
      )
    );
    expect(values[1]).toEqual(values[0]);
    expect(values[0]).toHaveLength(4);
  },
);
test(
  "visual.standalone-siblings-style-and-disclosure-lifetimes",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "siblings");
    await expect(page.locator(".otk-work-fold")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page.locator(".otk-work-fold").click();
    const disclosure = page.locator(
      ".otk-revert-group .otk-record-group-toggle",
    );
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const file = page.locator(".otk-revert-records .otk-control-row").filter({
      has: page.locator(".otk-path"),
    });
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await page.evaluate((theme) => {
        (window as unknown as { styleTest: { theme(id: string): void } })
          .styleTest.theme(theme);
      }, theme);
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await expect(file).toHaveCount(1);
      await expect(file.locator(".otk-path")).toHaveText("src/owner.ts");
      await expect(file.locator(".otk-diff-add")).toHaveText("+3");
      await expect(file.locator(".otk-diff-del")).toHaveText("\u22121");
      const colors = await file.evaluate((element) =>
        [".otk-path", ".otk-diff-add", ".otk-diff-del"].map((selector) =>
          getComputedStyle(element.querySelector(selector)!).color
        )
      );
      expect(colors[1]).not.toBe(colors[0]);
      expect(colors[2]).not.toBe(colors[0]);
      await page.screenshot({
        path: test.info().outputPath(`revert-files-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    expect(
      await page.locator(".otk-work-fold").evaluate((el) =>
        getComputedStyle(el).display
      ),
    ).toBe("flex");
    expect(
      await page.locator(".otk-view-header").evaluate((el) =>
        getComputedStyle(el).display
      ),
    ).toBe("flex");
    expect(
      await page.locator(".otk-empty").evaluate((el) =>
        getComputedStyle(el).padding
      ),
    ).toBe("12px");
    await page.locator(".otk-work-fold").click();
    await expect(page.locator(".otk-work-body")).toHaveCount(0);
    await page.locator(".otk-work-fold").click();
    await expect(page.locator(".otk-work-body")).toBeVisible();
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(file).toHaveCount(0);
  },
);
test(
  "visual.chrome-input-owned-reservation-collapse-and-trigger-slot",
  tags,
  async ({ isolatedState: state, page }) => {
    await scene(page, state.url, "chrome");
    const padding = () =>
      page.locator(".otk-task-strip").evaluate((el) =>
        getComputedStyle(el).paddingRight
      );
    await page.evaluate("styleTest.reserve(false);styleTest.collapse(false)");
    const normal = await padding();
    await page.evaluate(
      "document.body.className='otk-app';document.body.dataset.rightCollapsed='true'",
    );
    expect(await padding()).toBe(normal);
    await page.evaluate("document.body.className='';styleTest.reserve(true)");
    await expect.poll(padding).not.toBe("12px");
    expect(await padding()).not.toBe(normal);
    await page.evaluate("styleTest.collapse(true)");
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(page.locator(".otk-server-connection .otk-server-label"))
      .toHaveCount(0);
    expect(
      (await page.locator(".otk-server-connection [role=img]").boundingBox())!
        .width,
    ).toBeGreaterThan(0);
    await expect(
      page.getByRole("button", { name: "Slot control", exact: true }),
    ).toHaveClass(/consumer-trigger/);
  },
);
