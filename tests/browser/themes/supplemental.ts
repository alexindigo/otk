// SPDX-License-Identifier: LGPL-3.0-only
import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { accessoryGeometry } from "../../support/control-geometry.ts";
import { selectionGeometry } from "../../support/selection-geometry.ts";
import type { TestState } from "../fixtures/test-state.ts";
import { restoreViewport } from "./capture.ts";

export async function supplemental(
  { state, page, cdp, scenes, themes, paint, shot }: {
    state: TestState;
    page: Page;
    cdp: CDPSession;
    scenes: string;
    themes: { id: string }[];
    paint(theme: { id: string }): Promise<void>;
    shot(name: string): Promise<void>;
  },
) {
  // Independent consumers own local preferences; the real media input keeps
  // their fixed captures static without replacing those preference contracts.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const frames = async () =>
    await page.evaluate(() =>
      document.fonts.ready.then(() =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      )
    );
  const scene = async (name: string) => {
    await page.goto(
      scenes + "/ui/?" + name + "&server=" + encodeURIComponent(state.url),
    );
  };
  await test.step("8/public-setup-diff-and-task-feedback", async () => {
    await scene("layout-controls");
    await expect(page.locator("select[name=type]")).toBeVisible();
    for (const theme of themes) {
      await paint(theme);
      for (const zoom of [1, 2]) {
        for (const physical of [600, 800, 1280, 1920]) {
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: physical / zoom,
            height: 1000 / zoom,
            deviceScaleFactor: zoom,
            mobile: false,
          });
          await frames();
          const g = await page.locator("[data-auth-pane]").evaluate((pane) => {
            const form = pane.querySelector("form")!,
              heading = pane.querySelector("h1,h2")!,
              description = heading.nextElementSibling!,
              r = pane.getBoundingClientRect(),
              f = form.getBoundingClientRect();
            const fields = Array.from(
              form.querySelectorAll("input:not(.otk-form-choice-value),select"),
            );
            return {
              center: Math.abs((f.left + f.right - r.left - r.right) / 2),
              edges: [heading, description, form, ...fields].map((e) =>
                e.getBoundingClientRect().left
              ),
              headings: pane.querySelectorAll("h1,h2").length,
              heights: fields.map((e) => e.getBoundingClientRect().height),
            };
          });
          expect(g.center).toBeLessThanOrEqual(1);
          expect(Math.max(...g.edges) - Math.min(...g.edges))
            .toBeLessThanOrEqual(1);
          expect(g.headings).toBe(1);
          expect(g.heights.length).toBeGreaterThan(0);
          expect(g.heights.every((h) => h === 32)).toBe(true);
          const icons = await page.evaluate(accessoryGeometry) as {
            gaps: number[];
          }[];
          expect(icons.length).toBeGreaterThanOrEqual(2);
          icons.forEach((g) =>
            expect(Math.max(...g.gaps) - Math.min(...g.gaps))
              .toBeLessThanOrEqual(1)
          );
          await shot(`public-setup-${physical}-zoom${zoom}-${theme.id}`);
        }
      }
      await restoreViewport(page, cdp);
      await page.setViewportSize({ width: 1280, height: 1000 });
    }
    await page.locator("select[name=type]").selectOption("none");
    await expect(page.locator("[data-auth-pane] input[name=username]"))
      .toHaveCount(0);
    for (const theme of themes) {
      await paint(theme);
      await shot(`public-setup-none-${theme.id}`);
    }
    await page.locator("select[name=type]").selectOption("password");
    await expect(page.locator("input[name=username]")).toBeVisible();
    for (
      const [wide, width, mode] of [[false, 800, "unified"], [
        true,
        1300,
        "split",
      ]] as const
    ) {
      await page.setViewportSize({ width: 1920, height: 1000 });
      if (wide) await page.locator("[data-wide-diff]").click();
      await expect(page.locator("[data-independent-diff] .otk-diff"))
        .toHaveAttribute("data-diff-style", mode);
      for (const theme of themes) {
        await paint(theme);
        expect(
          (await page.locator("[data-independent-diff] .otk-diff")
            .boundingBox())!.width,
        ).toBe(width);
        await shot(`public-independent-diff-${mode}-${theme.id}`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.locator("[data-task]").click();
    await page.locator("input[name=taskName]").fill("Retained task name");
    const boxes = () =>
      page.locator(
        "dialog[open] h2,dialog[open] input[name=taskName],dialog[open] .otk-action-slot",
      ).evaluateAll((els) =>
        els.flatMap((el) => {
          const r = el.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        })
      );
    const idle = await boxes();
    await page.locator("dialog[open] button[type=submit]").click();
    await expect(page.locator("dialog[open] form")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    for (const theme of themes) {
      await paint(theme);
      (await boxes()).forEach((v, i) =>
        expect(Math.abs(v - idle[i])).toBeLessThanOrEqual(1)
      );
      await shot(`public-task-geometry-pending-${theme.id}`);
    }
    await page.locator("[data-reject]").evaluate((el) =>
      (el as HTMLElement).click()
    );
    await expect(page.locator("dialog[open] [role=alert]")).toHaveCount(1);
    for (const theme of themes) {
      await paint(theme);
      // Complete failure prose expands a centered dialog. Controls keep their
      // horizontal geometry and dimensions, not obsolete absolute Y positions.
      (await boxes()).forEach((v, i) =>
        i % 4 !== 1 && expect(Math.abs(v - idle[i])).toBeLessThanOrEqual(1)
      );
      await expect(page.locator("dialog[open] input[name=taskName]"))
        .toHaveValue("Retained task name");
      const geometry = await page.locator("dialog[open]").evaluate((dialog) => {
        const box = dialog.getBoundingClientRect();
        const controls = [
          dialog.querySelector("h2")!,
          dialog.querySelector("input[name=taskName]")!,
          dialog.querySelector(".otk-action-slot")!,
        ].map((el) => el.getBoundingClientRect());
        const failure = dialog.querySelector(".otk-failure-content")!;
        return {
          centered: [
            Math.abs((box.left + box.right - innerWidth) / 2),
            Math.abs((box.top + box.bottom - innerHeight) / 2),
          ],
          controlsInside: controls.every((r) =>
            r.left >= box.left - 1 && r.right <= box.right + 1 &&
            r.top >= box.top - 1 && r.bottom <= box.bottom + 1
          ),
          ordered: controls.every((r, i) =>
            !i || r.top >= controls[i - 1].bottom
          ),
          failureInside: Array.from(failure.children).every((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const r = range.getBoundingClientRect();
            return r.left >= box.left - 1 && r.right <= box.right + 1 &&
              r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
          }),
        };
      });
      geometry.centered.forEach((delta) =>
        expect(delta).toBeLessThanOrEqual(1)
      );
      expect(geometry.controlsInside).toBe(true);
      expect(geometry.ordered).toBe(true);
      expect(geometry.failureInside).toBe(true);
      expect(
        await page.locator("dialog[open] [role=alert]").evaluate((el) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--otk-danger)";
          document.body.append(probe);
          const equal =
            getComputedStyle(el).color === getComputedStyle(probe).color;
          probe.remove();
          return equal;
        }),
      ).toBe(true);
      await shot(`public-task-geometry-error-${theme.id}`);
    }
    await page.keyboard.press("Escape");
  });
  await test.step("3/public-required-chip-editor", async () => {
    await scene("layout-tabs");
    await page.locator("[data-edit-chip]").click();
    const editor = page.getByRole("textbox", {
      name: "Rename session",
      exact: true,
    });
    const text = "abcdefghijklmnopqrstuvwxyz1234";
    await editor.fill(text);
    await editor.evaluate((el) =>
      el.setAttribute("data-retained-editor", "true")
    );
    for (const theme of themes) {
      await paint(theme);
      for (const width of [600, 800, 1280, 1920, 600]) {
        await page.setViewportSize({ width, height: 800 });
        await frames();
        await expect(editor).toBeFocused();
        await expect(editor).toHaveValue(text);
        await expect(editor).toHaveAttribute("data-retained-editor", "true");
        expect(
          await editor.evaluate((input) => {
            const row = input.closest(".otk-breadcrumb-row")!,
              r = row.getBoundingClientRect(),
              i = input.getBoundingClientRect(),
              feedback = document.getElementById(
                input.getAttribute("aria-describedby")!,
              )!,
              f = feedback.getBoundingClientRect();
            return i.top >= r.top - 1 && i.bottom <= r.bottom + 1 &&
              !!document.querySelector('[data-crumb="tstv1-independent-6"]') &&
              f.top >= r.bottom - 1 && f.height >= 20;
          }),
        ).toBe(true);
        await shot(`public-chip-editor-${width}-${theme.id}`);
      }
    }
    await editor.press("Enter");
    await expect(editor).toHaveJSProperty("readOnly", true);
    for (const theme of themes) {
      await paint(theme);
      await shot(`public-chip-pending-${theme.id}`);
    }
    await page.locator("[data-reject-chip]").evaluate((el) =>
      (el as HTMLElement).click()
    );
    await expect(page.locator("[role=alert]")).toBeVisible();
    for (const theme of themes) {
      await paint(theme);
      await expect(editor).toHaveValue(text);
      expect(
        await page.locator("[role=alert]").evaluate((el) => {
          const r = el.getBoundingClientRect();
          return document.elementFromPoint(
            r.x + r.width / 2,
            r.y + r.height / 2,
          )?.closest("[role=alert]") === el;
        }),
      ).toBe(true);
      await shot(`public-chip-error-${theme.id}`);
    }
  });
  await test.step("3/public-files-icons-and-restored-answer", async () => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await scene("shared-controls");
    await expect(page.locator("[data-diffs] .otk-tool-toggle")).toHaveCount(2);
    expect(
      await page.locator("[data-diffs] .otk-tool-toggle").evaluateAll((els) =>
        els.map((e) => e.getAttribute("aria-expanded"))
      ),
    ).toEqual(["false", "false"]);
    for (const tool of ["edit", "patch"]) {
      await page.locator(`[data-diffs] [data-tool=${tool}] .otk-tool-toggle`)
        .click();
    }
    const answer = page.locator("textarea[name=question-answer]");
    const text = Array.from(
      { length: 6 },
      (_, i) => `Restored answer line ${i + 1}`,
    ).join("\n");
    await answer.fill(text);
    await page.getByRole("button", { name: "Hide the question", exact: true })
      .click();
    await page.getByRole("button", { name: "Show the question", exact: true })
      .click();
    await page.locator("[data-remount]").click();
    await expect(answer).toHaveCount(0);
    await page.locator("[data-remount]").click();
    await expect(answer).toHaveValue(text);
    await page.locator("textarea[name=prompt]").fill("@");
    await expect(page.locator(".otk-autocomplete button")).toHaveCount(2);
    for (const theme of themes) {
      await paint(theme);
      expect(
        await page.locator("[data-diffs] .otk-diff").evaluateAll((els) =>
          els.map((
            e,
          ) => [
            e.getAttribute("aria-label"),
            !!e.querySelector("header"),
            Array.from(e.querySelectorAll(".otk-diff-text")).map((x) =>
              x.textContent
            ).join("|"),
          ])
        ),
      ).toEqual([["Modified a.ts", false, "old|new"], [
        "Modified a.ts",
        false,
        "old|new",
      ]]);
      expect(
        await page.locator("[data-diffs] .otk-tool-toggle").evaluateAll((els) =>
          els.every((e) =>
            e.textContent!.includes("+1") && e.textContent!.includes("\u22121")
          )
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() =>
          [
            ".otk-inbox-brand svg",
            ".otk-tool-icon svg",
            ".otk-takeover-collapse svg",
          ].map((s) => {
            const e = document.querySelector(s)!, r = e.getBoundingClientRect();
            return [
              e.getAttribute("viewBox"),
              e.getAttribute("stroke-width"),
              e.getAttribute("aria-hidden"),
              r.width,
              r.height,
            ];
          })
        ),
      ).toEqual([["0 0 24 24", "1.75", "true", 16, 16], [
        "0 0 24 24",
        "1.75",
        "true",
        13,
        13,
      ], ["0 0 24 24", "1.75", "true", 16, 16]]);
      await expect(answer).toHaveValue(text);
      expect(await answer.evaluate((e) => e.clientHeight >= e.scrollHeight - 1))
        .toBe(true);
      const marks = await selectionGeometry({
        send: (method, params = {}) =>
          cdp.send(method as Parameters<CDPSession["send"]>[0], params),
      }, ".otk-autocomplete button");
      expect(marks).toHaveLength(2);
      for (const g of marks) {
        expect([g.orientation, g.w, g.h, g.shift]).toEqual([
          "vertical",
          3,
          14,
          0,
        ]);
        expect(g.centred).toBeLessThan(.5);
      }
      await shot(`public-shared-controls-${theme.id}`);
    }
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
