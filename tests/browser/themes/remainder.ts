// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import {
  labelTextBounds,
  type TaskMarkerGeometry,
  taskMarkerGeometry,
} from "../../support/control-geometry.ts";
import { labels } from "./labels.ts";
import { fixedContent } from "./content.ts";
import { readyMenuBox } from "../pages/menus.ts";
import { expandedFailure } from "../pages/failure-geometry.ts";
interface Inputs {
  state: TestState;
  page: Page;
  themes: { id: string }[];
  scenes: string;
  content: { sessionID: string };
  paint(theme: { id: string }): Promise<void>;
  shot(name: string): Promise<void>;
}
interface Checkboxes {
  controls: {
    width: number;
    height: number;
    padding: number;
    right: number;
    parentRight: number;
  }[];
  labels: {
    gap: number;
    centers: number;
    right: number;
    parentRight: number;
  }[];
  selects: {
    padding: number;
    right: number;
    parentRight: number;
    gap: number;
    centers: number;
    value: string;
  }[];
  tasks: TaskMarkerGeometry[];
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
const bounds = async (page: Page, selector: string) =>
  await page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  });
export async function remainder(
  { state, page, themes, scenes, content, paint, shot }: Inputs,
) {
  const scene = async (name: string) => {
    await page.goto(
      scenes + "/styles/?scene=" + name + "&server=" +
        encodeURIComponent(state.url),
    );
    await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  };
  await test.step("8/public-feedback-states", async () => {
    for (const theme of themes) {
      await scene("forms");
      await paint(theme);
      const before = await bounds(page, ".otk-form");
      const calls = Number(
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
      await expect(page.locator(".otk-form input").first()).toHaveJSProperty(
        "readOnly",
        true,
      );
      await expect(page.locator(".otk-form input").first()).toHaveValue("perf");
      expect(await bounds(page, ".otk-form")).toEqual(before);
      await shot(`public-form-pending-${theme.id}`);
      await page.evaluate("styleTest.feedback('error')");
      await expect(page.locator("[role=alert]")).toHaveText(
        /No publishable failure reason is available/,
      );
      await expandedFailure(page, ".otk-form", before);
      await expect(page.locator(".otk-form input").first()).toHaveJSProperty(
        "readOnly",
        false,
      );
      await shot(`public-form-error-${theme.id}`);
      for (const name of ["notes", "kind"]) {
        await page.locator(".otk-form button[type=submit]").click();
        await expect(page.locator(".otk-form")).toHaveAttribute(
          "aria-busy",
          "true",
        );
        await expect(page.getByRole("status")).toBeFocused();
        await expect(page.locator("textarea[name=notes]")).toHaveJSProperty(
          "readOnly",
          true,
        );
        await expect(page.locator(".otk-form-choice-value")).toHaveValue(
          "Alpha",
        );
        await page.evaluate(`styleTest.fieldFailure('${name}')`);
        const field = page.locator(`[name=${name}]`);
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
        await expandedFailure(page, ".otk-form", before);
        await expect(page.locator("textarea[name=notes]")).toHaveValue(
          "Keep this text",
        );
        await shot(`public-form-${name}-${theme.id}`);
      }
      await scene("preference-feedback");
      await page.locator(`[data-theme-choice="${theme.id}"]`).click();
      await paint(theme);
      await page.setViewportSize({ width: 1280, height: 1000 });
      for (const name of ["theme", "keys"]) {
        const selector = `[data-preference-surface=${name}]`,
          surface = page.locator(selector),
          rect = await bounds(page, selector);
        await surface.getByRole("button", {
          name: name === "theme" ? "Save theme" : "Reset all shortcuts",
          exact: true,
        }).click();
        await expect(surface.getByRole("status")).toBeFocused();
        await expect(surface.locator("[disabled],[aria-disabled=true]"))
          .toHaveCount(0);
        await shot(`public-${name}-pending-${theme.id}`);
        await page.evaluate("styleTest.settlePreference()");
        await expect(surface.locator("[role=alert]")).not.toBeEmpty();
        await expandedFailure(page, selector, rect);
        await shot(`public-${name}-error-${theme.id}`);
      }
      await scene("lists");
      await paint(theme);
      await page.evaluate("styleTest.holdMenu(true)");
      await page.getByRole("button", {
        name: "Reactive list menu",
        exact: true,
      }).click();
      const menu = page.locator(":popover-open");
      const box = await readyMenuBox(menu, ["one", "two", "delete"]);
      const size = [box.width, box.height];
      await menu.locator('[data-context-command="list.one"]').focus();
      await page.keyboard.press("Enter");
      await expect(menu.getByRole("status")).toBeFocused();
      expect(
        await menu.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return [r.width, r.height];
        }),
      ).toEqual(size);
      await expect(menu.locator("[disabled],[aria-disabled=true]")).toHaveCount(
        0,
      );
      expect(
        await menu.locator("[role=menuitem]").evaluateAll((els) =>
          els.filter((el) =>
            el.getClientRects().length &&
            getComputedStyle(el).visibility !== "hidden"
          ).length
        ),
      ).toBe(0);
      await shot(`public-menu-pending-${theme.id}`);
      await page.evaluate("styleTest.settleMenu(true)");
      await expect(menu.locator("[role=alert]")).toHaveText(
        /No publishable failure reason is available/,
      );
      const feedbackHeight = await menu.getByRole("alert").evaluate((el) =>
        el.getBoundingClientRect().height +
        parseFloat(getComputedStyle(el.parentElement!).rowGap)
      );
      expect(
        await menu.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return [r.width, r.height];
        }),
      ).toEqual([size[0], size[1] + feedbackHeight]);
      await expect(menu.locator('[data-context-command="list.one"]'))
        .toBeFocused();
      await shot(`public-menu-error-${theme.id}`);
      await page.keyboard.press("Escape");
    }
  });
  await test.step("8/public-dialog-identity-and-project-failure", async () => {
    for (
      const [name, setup] of [["task", "dialogTest.task('Replacement task')"], [
        "dismissal",
        "dialogTest.probe('Replacement dismissal')",
      ], ["palette", "dialogTest.palette()"]]
    ) {
      await page.goto(
        scenes + "/dialog/?server=" + encodeURIComponent(state.url),
      );
      await page.locator("#origin").click();
      await page.evaluate(setup);
      if (name === "palette") {
        await page.locator('[data-command="consumer.action"]').click();
        await expect(page.locator("input[name=command-search]")).toHaveCount(0);
      }
      for (const theme of themes) {
        await paint(theme);
        if (name === "task") {
          await expect(page.locator("dialog[open] input")).toHaveValue(
            "Replacement task",
          );
        }
        if (name === "dismissal") {
          await expect(page.locator("dialog[open]")).toHaveAttribute(
            "aria-label",
            "Replacement dismissal",
          );
        }
        await shot(`public-dialog-${name}-${theme.id}`);
      }
      if (name === "task") {
        await page.locator(".otk-form button[type=submit]").click();
        await expect(page.locator(".otk-form")).toHaveAttribute(
          "aria-busy",
          "true",
        );
        const rect = await bounds(page, ".otk-form");
        for (const theme of themes) {
          await paint(theme);
          expect(await bounds(page, ".otk-form")).toEqual(rect);
          await shot(`public-task-pending-${theme.id}`);
        }
        await page.evaluate("dialogTest.finish()");
      }
    }
    await page.goto(
      scenes + "/context/?server=" + encodeURIComponent(state.url),
    );
    await page.locator("#mount-project-probe").click();
    for (const theme of themes) {
      await paint(theme);
      const trigger = page.locator("#project-probe .otk-project-menu > button");
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.locator(
        ':popover-open [role=menu][aria-label="Project menu for probe"] button',
      ).first().click();
      await expect(page.locator("#project-probe .otk-project-error"))
        .toBeVisible();
      expect(
        await page.locator("#project-probe .otk-project-error").evaluate(
          (el) => {
            const r = el.getBoundingClientRect(),
              row = el.closest("[data-project]")!.getBoundingClientRect(),
              action = el.closest("[data-project]")!.querySelector(
                ".otk-project-open",
              )!.getBoundingClientRect();
            return r.top >= action.bottom && r.bottom <= row.bottom &&
              r.left >= action.left && r.right <= row.right;
          },
        ),
      ).toBe(true);
      await shot(`public-project-error-${theme.id}`);
      await page.keyboard.press("Escape");
      await expect(page.locator(":popover-open")).toHaveCount(0);
    }
  });
  await test.step("6/remaining-timestamp-type-and-window-contracts", async () => {
    await fixedContent(state, page, content.sessionID, "reading");
    await state.product("layout.patch", {
      leftCollapsed: false,
      rightCollapsed: false,
      rightView: "sessions",
    });
    await page.goto(state.url + "/#/local/" + content.sessionID);
    await page.locator("[data-role=assistant] .otk-message-agent").first()
      .scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    const reply = page.locator("[data-role=assistant]").first();
    await expect(reply.locator(".otk-message-actions")).toHaveCSS(
      "opacity",
      "0",
    );
    await reply.evaluate((el) => {
      el.addEventListener(
        "mouseenter",
        () =>
          el.setAttribute("data-theme-hover-start", String(performance.now())),
        { once: true },
      );
      el.addEventListener(
        "mouseleave",
        () =>
          el.setAttribute("data-theme-leave-start", String(performance.now())),
        { once: true },
      );
      const observer = new MutationObserver(() => {
        if (el.classList.contains("is-revealed")) {
          el.setAttribute(
            "data-theme-hover-open",
            String(
              performance.now() -
                Number(el.getAttribute("data-theme-hover-start")),
            ),
          );
        } else if (el.hasAttribute("data-theme-leave-start")) {
          el.setAttribute(
            "data-theme-hover-close",
            String(
              performance.now() -
                Number(el.getAttribute("data-theme-leave-start")),
            ),
          );
          observer.disconnect();
        }
      });
      observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    });
    await reply.locator(".otk-message-content").hover();
    await expect.poll(async () =>
      Number(await reply.getAttribute("data-theme-hover-open"))
    ).toBeGreaterThanOrEqual(500);
    const fixed = await bounds(page, "[data-role=assistant]");
    expect(
      await reply.locator(".otk-message-footer").evaluate((footer) => {
        const a = footer.querySelector('[data-message-command="reply.copy"]')!
            .getBoundingClientRect(),
          b = footer.querySelector(".otk-last-output-time")!
            .getBoundingClientRect();
        return b.left - a.right ===
          parseFloat(getComputedStyle(footer).columnGap);
      }),
    ).toBe(true);
    await page.mouse.move(1, 1);
    await expect(reply).not.toHaveClass(/is-revealed/);
    expect(Number(await reply.getAttribute("data-theme-hover-close")))
      .toBeGreaterThanOrEqual(150);
    expect(await bounds(page, "[data-role=assistant]")).toEqual(fixed);
    for (const theme of themes) {
      await paint(theme);
      const selectors = [
        "html",
        ".otk-project-name",
        ".otk-text",
        ".otk-code pre",
        ".otk-prompt textarea",
        ".otk-server-connection",
      ];
      const read = () =>
        page.evaluate((selectors) =>
          selectors.map((selector) => {
            const el = document.querySelector(selector)!,
              s = getComputedStyle(el);
            return [s.fontSize, s.lineHeight];
          }), selectors);
      const baseline = await read();
      await page.locator("html").evaluate((el) => {
        const s = (el as HTMLElement).style;
        Object.entries({
          "--text-ui": "17px",
          "--text-meta": "19px",
          "--text-prose": "18px",
          "--line-ui": "26px",
          "--line-prose": "32px",
        }).forEach(([key, value]) => s.setProperty(key, value));
      });
      expect(await read()).toEqual([
        ["17px", "26px"],
        ["17px", "26px"],
        ["18px", "32px"],
        ["17px", "26px"],
        ["18px", "32px"],
        ["19px", "26px"],
      ]);
      expect(
        await page.evaluate(() => {
          const parent = document.createElement("span"),
            small = document.createElement("small");
          parent.style.fontSize = "5px";
          small.textContent = "Minimum";
          parent.append(small);
          document.body.append(parent);
          const value = getComputedStyle(small).fontSize;
          parent.remove();
          return value;
        }),
      ).toBe("12px");
      await shot(`type-scaled-${theme.id}`);
      await page.locator("html").evaluate((el) =>
        [
          "--text-ui",
          "--text-meta",
          "--text-prose",
          "--line-ui",
          "--line-prose",
        ].forEach((key) => (el as HTMLElement).style.removeProperty(key))
      );
      expect(await read()).toEqual(baseline);
      const clock = page.locator(".otk-last-output-time").first();
      await clock.scrollIntoViewIfNeeded();
      await page.mouse.move(1, 1);
      const date = page.locator(".otk-last-output-date").first();
      await expect(date).toHaveCSS("visibility", "hidden");
      const rect = await clock.boundingBox();
      await clock.hover();
      await expect(date).toHaveCSS("visibility", "visible");
      const g = await clock.evaluate((el) => {
        const footer = el.closest(".otk-message-footer")!,
          date = footer.querySelector(".otk-last-output-date")!,
          d = date.getBoundingClientRect(),
          t = el.getBoundingClientRect(),
          f = footer.getBoundingClientRect();
        return {
          date: date.textContent!.trim(),
          expected: new Date((el as HTMLTimeElement).dateTime)
            .toLocaleDateString(),
          gap: t.left - d.right,
          centers: Math.abs(d.y + d.height / 2 - t.y - t.height / 2),
          right: Math.abs(f.right - t.right),
          left: t.left,
          width: t.width,
          color: getComputedStyle(footer).color === getComputedStyle(el).color,
        };
      });
      expect(g.date).toBe(g.expected);
      expect(g.gap).toBeGreaterThan(0);
      expect(g.centers).toBeLessThan(.5);
      expect(g.right).toBeLessThan(.5);
      expect(g.color).toBe(true);
      expect(Math.abs(g.left - rect!.x)).toBeLessThan(.5);
      expect(Math.abs(g.width - rect!.width)).toBeLessThan(.5);
      await shot(`timestamps-hover-${theme.id}`);
      for (const role of ["user", "assistant"]) {
        const trigger = page.locator(`[data-role=${role}] .otk-created-trigger`)
          .first();
        const created = page.locator(`[data-role=${role}] .otk-created-time`)
          .first();
        await trigger.scrollIntoViewIfNeeded();
        await trigger.hover();
        await expect(created).toHaveCSS("visibility", "visible");
        await shot(`timestamps-created-${role}-${theme.id}`);
        await page.mouse.move(1, 1);
        await expect(created).toHaveCSS("visibility", "hidden");
      }
      const ink = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        const color = (el: Element) => {
          ctx.clearRect(0, 0, 1, 1);
          const layers: Element[] = [];
          for (let n: Element | null = el; n; n = n.parentElement) {
            layers.unshift(n);
          }
          for (const n of layers) {
            ctx.fillStyle = getComputedStyle(n).backgroundColor;
            ctx.fillRect(0, 0, 1, 1);
          }
          ctx.fillStyle = getComputedStyle(el).color;
          ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
            .reduce((a, b) => a + b, 0);
        };
        return [
          color(document.querySelector(".otk-created-time")!),
          color(document.querySelector(".otk-created-trigger")!),
        ];
      });
      if (theme.id === "otk-dark") expect(ink[0]).toBeLessThan(ink[1]);
      else expect(ink[0]).toBeGreaterThan(ink[1]);
      const fork = reply.locator('[data-message-command="reply.fork"]');
      const forkBox = await fork.boundingBox();
      await page.keyboard.press("Tab");
      for (const action of ["focus", "blur", "hover", "leave"]) {
        const agent = reply.locator(".otk-message-agent");
        if (action === "focus") {
          await agent.evaluate((el) =>
            (el as HTMLElement).focus({ preventScroll: true })
          );
        }
        if (action === "blur") {
          await page.locator("textarea[name=prompt]").evaluate((el) =>
            (el as HTMLElement).focus({ preventScroll: true })
          );
        }
        if (action === "hover") await agent.hover();
        if (action === "leave") await page.mouse.move(1, 1);
        await expect.poll(() =>
          reply.locator(".otk-created-time").evaluate((el) =>
            getComputedStyle(el).display !== "none"
          )
        ).toBe(action === "focus" || action === "hover");
        expect(await fork.boundingBox()).toEqual(forkBox);
      }
      const copy = page.locator(
        '[data-role=user] [data-message-command="prompt.copy"]',
      ).first();
      await page.locator(".otk-user-bubble").first().scrollIntoViewIfNeeded();
      const slot = await copy.boundingBox();
      await page.locator(".otk-user-bubble").first().focus();
      await expect(
        page.locator("[data-role=user] .otk-message-actions").first(),
      ).toHaveCSS("opacity", "1");
      expect(await copy.boundingBox()).toEqual(slot);
      await page.context().grantPermissions([
        "clipboard-read",
        "clipboard-write",
      ]);
      await copy.click();
      expect(await copy.boundingBox()).toEqual(slot);
      await state.product("prefs.set", { key: "timestamps", value: true });
      await expect.poll(() =>
        page.locator(".otk-created-time").evaluateAll((els) =>
          els.every((el) => getComputedStyle(el).visibility === "visible")
        )
      ).toBe(true);
      await shot(`timestamps-always-${theme.id}`);
      await state.product("prefs.set", { key: "timestamps", value: false });
      const bubble = page.locator(".otk-user-bubble").first();
      await bubble.scrollIntoViewIfNeeded();
      expect(
        await bubble.evaluate((el) => {
          const b = el.getBoundingClientRect(),
            lane = el.closest(".otk-message-flow")!.getBoundingClientRect();
          return b.width <= lane.width * .8 + .5 &&
            Math.abs(b.right - lane.right) < .5;
        }),
      ).toBe(true);
      const promptGeometry = await bubble.evaluate((el) => {
        const b = el.getBoundingClientRect(),
          t = el.querySelector(".otk-prose-paragraph")!.getBoundingClientRect();
        return {
          height: b.height,
          text: t.height,
          balanced: Math.abs((t.top - b.top) - (b.bottom - t.bottom)),
        };
      });
      expect(Math.abs(promptGeometry.height - 48)).toBeLessThanOrEqual(1);
      expect(promptGeometry.text).toBe(24);
      expect(promptGeometry.balanced).toBeLessThanOrEqual(1);
      await shot(`window-bubble-${theme.id}`);
      await frames(page);
    }
  });
  await test.step("8/native-controls-without-consumer-overrides", async () => {
    await page.goto(
      scenes + "/?scene=controls&server=" + encodeURIComponent(state.url),
    );
    await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
    const compact = [
      "checkbox",
      "RADIO",
      "range",
      "color",
      "file",
      "button",
      "submit",
      "reset",
      "image",
    ];
    const labels = await page.evaluate<{ before: unknown; direct: unknown }>(
      `(()=>{const bounds=${labelTextBounds},field=document.querySelector('[data-compact="0"]'),span=field.nextElementSibling,text=document.createTextNode(span.textContent),before=bounds(field);span.replaceWith(text);const direct=bounds(field);text.replaceWith(span);return {before,direct}})()`,
    );
    expect(labels.direct).toEqual(labels.before);
    await page.locator("#native-reference").evaluate((el, compact) => {
      const root = el.attachShadow({ mode: "open" });
      compact.forEach((type, i) => {
        const label = document.createElement("label");
        Object.assign(label.style, {
          display: "flex",
          alignItems: "center",
          gap: "10px",
        });
        const input = document.createElement("input");
        input.type = type;
        input.dataset.native = String(i);
        if (type === "image") {
          input.alt = "Image";
          input.src =
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3C/svg%3E";
        }
        Object.assign(input.style, {
          font: "inherit",
          color: "inherit",
          boxSizing: "border-box",
        });
        const span = document.createElement("span");
        span.textContent = "Pick";
        label.append(input, span);
        root.append(label);
      });
    }, compact);
    for (const theme of themes) {
      await paint(theme);
      for (const width of [320, 920]) {
        await page.locator("[data-native-controls]").evaluate(
          (el, width) => (el as HTMLElement).style.width = width + "px",
          width,
        );
        const g = await page.locator("[data-native-controls]").evaluate(
          (el) => {
            const root = getComputedStyle(document.documentElement),
              shadow = el.querySelector("#native-reference")!.shadowRoot!,
              probe = document.createElement("div");
            probe.style.background = "var(--bg)";
            probe.style.border = "1px solid var(--muted)";
            document.body.append(probe);
            const paint = getComputedStyle(probe),
              bg = paint.backgroundColor,
              border = paint.borderTopColor;
            probe.remove();
            return {
              bg,
              border,
              color: root.color,
              font: root.fontFamily,
              hidden:
                el.querySelector("input[type=hidden]")!.getBoundingClientRect()
                  .width,
              fields: Array.from(el.querySelectorAll("[data-field]")).map(
                (e) => {
                  const c = getComputedStyle(e);
                  return {
                    width: e.getBoundingClientRect().width,
                    padding: parseFloat(c.paddingLeft),
                    bg: c.backgroundColor,
                    border: c.borderTopColor,
                    font: c.fontFamily,
                    color: c.color,
                  };
                },
              ),
              compact: Array.from(el.querySelectorAll("[data-compact]")).map(
                (e, i) => {
                  const r = e.getBoundingClientRect(),
                    row = e.parentElement!.getBoundingClientRect(),
                    label = e.nextElementSibling!.getBoundingClientRect(),
                    native = shadow.querySelector(`[data-native="${i}"]`)!,
                    n = native.getBoundingClientRect(),
                    nl = native.nextElementSibling!.getBoundingClientRect(),
                    c = getComputedStyle(e);
                  return {
                    width: r.width,
                    height: r.height,
                    nativeWidth: n.width,
                    nativeHeight: n.height,
                    nativeCenters: Math.abs(
                      n.y + n.height / 2 - nl.y - nl.height / 2,
                    ),
                    gap: label.left - r.right,
                    centers: Math.abs(
                      r.y + r.height / 2 - label.y - label.height / 2,
                    ),
                    right: label.right,
                    rowRight: row.right,
                    font: c.fontFamily,
                    color: c.color,
                  };
                },
              ),
            };
          },
        );
        for (const field of g.fields) {
          expect(field.width).toBe(width);
          expect(Math.abs(field.padding - 8)).toBeLessThan(.05);
          expect(field.bg).toBe(g.bg);
          expect(field.border).toBe(g.border);
          expect(field.font).toBe(g.font);
          expect(field.color).toBe(g.color);
        }
        for (const control of g.compact) {
          expect(Math.abs(control.width - control.nativeWidth)).toBeLessThan(
            .1,
          );
          expect(Math.abs(control.height - control.nativeHeight)).toBeLessThan(
            .1,
          );
          expect(control.gap).toBeGreaterThanOrEqual(10);
          expect(control.gap).toBeLessThanOrEqual(15);
          expect(Math.abs(control.centers - control.nativeCenters))
            .toBeLessThanOrEqual(.5);
          expect(control.right).toBeLessThanOrEqual(control.rowRight + .5);
          expect(control.font).toBe(g.font);
          expect(control.color).toBe(g.color);
        }
        expect(g.hidden).toBe(0);
        expect(
          await page.locator("#hidden-action,#hidden-group").evaluateAll(
            (els) =>
              els.map(
                (el) => [
                  getComputedStyle(el).display,
                  el.getClientRects().length,
                ],
              ),
          ),
        ).toEqual([["none", 0], ["none", 0]]);
        await shot(`native-controls-${width}-${theme.id}`);
      }
    }
  });
  await test.step("8/long-control-labels", async () => {
    const longName =
      "Review the complete dependency graph and every affected consumer";
    await state.product("tasks.create", {
      directory: state.directory,
      name: longName,
      sessions: [content.sessionID],
    });
    const select = async (name: string) => {
      await fixedContent(state, page, content.sessionID, name);
    };
    for (const theme of themes) {
      for (const width of [1280, 800]) {
        await select("labels");
        await paint(theme);
        await page.setViewportSize({ width, height: 800 });
        await state.product("layout.patch", {
          rightCollapsed: true,
          leftCollapsed: false,
        });
        await expect(page.locator(".otk-tool-error-toggle").first())
          .toBeVisible();
        expect(
          await page.locator(".otk-tool-error-toggle").first().evaluate(
            (action) => {
              const row = action.parentElement!,
                summary = row.querySelector(".otk-tool-brief")!,
                r = row.getBoundingClientRect(),
                a = action.getBoundingClientRect(),
                s = summary.getBoundingClientRect();
              return a.right <= r.right + .5 && s.right <= a.left + .5 &&
                action.scrollWidth <= action.clientWidth &&
                summary.getAttribute("title")!.includes(
                  "every affected consumer",
                ) && getComputedStyle(summary).textOverflow === "ellipsis" &&
                summary.scrollWidth > summary.clientWidth;
            },
          ),
        ).toBe(true);
        await labels(page);
        await shot(`labels-transcript-${width}-${theme.id}`);
        for (const kind of ["agent", "model"]) {
          await page.locator(`.otk-${kind}-picker > button`).click();
          await expect(
            page.locator(`.otk-${kind}-picker :popover-open .otk-picker-option`)
              .first(),
          ).toBeVisible();
          await frames(page);
          await labels(page);
          expect(
            await page.locator(
              kind === "agent"
                ? ".otk-picker-option span[title]"
                : ".otk-picker-groups h3",
            ).evaluateAll((els) =>
              els.some((el) =>
                el.getAttribute("title") === el.textContent &&
                el.scrollWidth > el.clientWidth &&
                getComputedStyle(el).textOverflow === "ellipsis"
              )
            ),
          ).toBe(true);
          await shot(`labels-${kind}-${width}-${theme.id}`);
          await page.keyboard.press("Escape");
        }
        await page.locator(".otk-tool-error-toggle").first().click();
        await expect(page.locator(".otk-tool-error[role=alert]").first())
          .toBeVisible();
        await labels(page);
        await shot(`labels-error-${width}-${theme.id}`);
        await page.locator(".otk-tool-error-toggle").first().click();
        await page.locator(".otk-tool-toggle").first().focus();
        await page.keyboard.press("Shift+F10");
        await expect(page.locator(":popover-open [role=menu]")).toBeVisible();
        await labels(page);
        await shot(`labels-menu-${width}-${theme.id}`);
        await page.keyboard.press("Escape");
        await state.product("layout.patch", {
          rightCollapsed: false,
          rightWidth: 320,
        });
        await labels(page);
        expect(
          await page.locator("h3[data-session-group] .otk-control-label")
            .evaluateAll(
              (els, longName) =>
                els.some((el) =>
                  el.getAttribute("title") === longName &&
                  el.textContent === longName &&
                  el.scrollWidth > el.clientWidth &&
                  getComputedStyle(el).textOverflow === "ellipsis" &&
                  el.getBoundingClientRect().right <=
                    el.parentElement!.getBoundingClientRect().right + .5
                ),
              longName,
            ),
        ).toBe(true);
        const crowded = await page.locator(".otk-tool-toggle").evaluateAll(
          (els) =>
            els.map((el) => {
              const row = el.parentElement!,
                action = row.querySelector(".otk-tool-error-toggle")!,
                e = el.getBoundingClientRect(),
                a = action.getBoundingClientRect(),
                r = row.getBoundingClientRect(),
                sameRow =
                  Math.abs((e.top + e.bottom - a.top - a.bottom) / 2) < .5;
              return {
                sameRow,
                fits: el.scrollWidth <= el.clientWidth &&
                  e.right <= r.right + .5 && a.right <= r.right + .5 &&
                  (sameRow ? e.right <= a.left : a.top >= e.bottom),
              };
            }),
        );
        expect(crowded.every((r) => r.fits && r.sameRow === (width === 1280)))
          .toBe(true);
        await shot(`labels-panel-${width}-${theme.id}`);
        await state.product("layout.patch", { rightCollapsed: true });
        for (
          const [query, id, ready] of [
            ["Settings", "settings.open", ".otk-settings"],
            ["theme", "theme.open", ".otk-theme-choices"],
            ["Keyboard shortcuts", "help.keys", ".otk-keys-list"],
            ["Edit prompt", "prompt.editor", ".otk-editor"],
          ]
        ) {
          await page.keyboard.press("Control+k");
          await labels(page);
          await page.locator("input[name=command-search]").fill(query);
          await page.locator(`[data-command="${id}"]`).click();
          await expect(page.locator(ready)).toBeVisible();
          await labels(page);
          await shot(`labels-${id}-${width}-${theme.id}`);
          if (id === "settings.open") {
            await page.locator(".otk-settings .otk-view-header button").click();
          } else await page.keyboard.press("Escape");
        }
        for (const name of ["permission", "question"]) {
          await select("labels-" + name);
          await expect(page.locator(`.otk-${name}-dock`)).toBeVisible();
          await labels(page);
          await shot(`labels-${name}-${width}-${theme.id}`);
        }
      }
    }
  });
  await test.step("8/native-display-and-markdown-controls", async () => {
    await state.product("prefs.set", { key: "thinking", value: "hide" });
    await state.product("prefs.set", { key: "diffStyle", value: "auto" });
    await fixedContent(state, page, content.sessionID, "controls");
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const theme of themes) {
      await paint(theme);
      await page.locator(".otk-display-menu > button").click();
      const g = await page.evaluate<Checkboxes>(
        `(()=>{const bounds=${labelTextBounds};return {controls:[...document.querySelectorAll('.otk-display-menu input')].map(el=>{const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return {width:r.width,height:r.height,padding:parseFloat(getComputedStyle(el).paddingLeft),right:r.right,parentRight:p.right};}),labels:[...document.querySelectorAll('.otk-display-menu input')].map(el=>{const r=el.getBoundingClientRect(),t=bounds(el),p=el.parentElement.getBoundingClientRect();return {gap:t.left-r.right,centers:Math.abs(r.y+r.height/2-t.y-t.height/2),right:t.right,parentRight:p.right};}),selects:[...document.querySelectorAll('.otk-display-menu select')].map(el=>{const r=el.getBoundingClientRect(),t=bounds(el),p=el.parentElement.getBoundingClientRect();return {padding:parseFloat(getComputedStyle(el).paddingLeft),right:r.right,parentRight:p.right,gap:r.left-t.right,centers:Math.abs(r.y+r.height/2-t.y-t.height/2),value:el.value};}),tasks:(${taskMarkerGeometry})()};})()`,
      );
      expect(g.controls.length).toBe(g.labels.length);
      expect(g.labels.length).toBeGreaterThan(0);
      for (const c of g.controls) {
        expect(c.width).toBeGreaterThan(0);
        expect(c.width).toBeLessThanOrEqual(18);
        expect(c.height).toBeGreaterThan(0);
        expect(c.height).toBeLessThanOrEqual(18);
        expect(c.padding).toBe(0);
        expect(c.right).toBeLessThanOrEqual(c.parentRight);
      }
      for (const l of g.labels) {
        expect(l.gap).toBeGreaterThanOrEqual(9.05);
        expect(l.gap).toBeLessThanOrEqual(15);
        expect(l.centers).toBeLessThanOrEqual(.5);
        expect(l.right).toBeLessThanOrEqual(l.parentRight + .5);
      }
      for (const s of g.selects) {
        expect(Math.abs(s.padding - 8)).toBeLessThan(.05);
        expect(Math.abs(s.gap - 8)).toBeLessThan(.05);
        expect(s.centers).toBeLessThanOrEqual(.5);
        expect(Math.abs(s.right - s.parentRight)).toBeLessThanOrEqual(.5);
      }
      // Thinking is the same saved hide/show preference, now projected as a
      // positive checkbox; its geometry is covered by the input checks above.
      expect(g.selects.map((s: { value: string }) => s.value)).toEqual([
        "auto",
      ]);
      const thinking = page.locator('.otk-display-menu input[name="thinking"]');
      await expect(thinking).toHaveAccessibleName("Expand thinking by default");
      await expect(thinking).not.toBeChecked();
      // Rule 3 supersedes disabled Markdown checkbox controls with named status images.
      expect(g.tasks.map((t) => t.label)).toEqual(["Not done", "Done"]);
      await expect(page.locator(".otk-text li > input")).toHaveCount(0);
      for (const task of g.tasks) {
        expect([task.tag, task.role, task.controls, task.tabIndex]).toEqual([
          "SPAN",
          "img",
          0,
          null,
        ]);
        expect([task.width, task.height]).toEqual([task.line, task.line]);
        for (const delta of task.centres) expect(delta).toBeLessThanOrEqual(.5);
      }
      expect(g.tasks.map((t) => t.text)).toEqual([
        "Unchecked task",
        "Checked task",
      ]);
      await shot(`native-checkboxes-${theme.id}`);
      await page.keyboard.press("Escape");
      await page.locator(".otk-settings-entry").click();
      await expect(page.locator('.otk-settings input[name="url"]'))
        .toBeVisible();
      const fields = await page.locator(".otk-settings input").evaluateAll((
        els,
      ) =>
        els.filter((el) =>
          ["text", "url"].includes((el as HTMLInputElement).type)
        ).map((el) => ({
          name: (el as HTMLInputElement).name,
          width: el.getBoundingClientRect().width,
          parent: el.parentElement!.getBoundingClientRect().width,
          padding: parseFloat(getComputedStyle(el).paddingLeft),
        }))
      );
      expect(fields.map((f) => f.name)).toEqual(["url", "label"]);
      fields.forEach((f) => {
        expect(f.width).toBe(f.parent);
        expect(Math.abs(f.padding - 8)).toBeLessThan(.05);
      });
      const notifications = await page.evaluate<
        {
          name: string;
          width: number;
          height: number;
          padding: number;
          gap: number;
          centers: number;
          fits: boolean;
        }[]
      >(`(()=>{const textBounds=${labelTextBounds};return [...document.querySelectorAll('.otk-notification-settings input[type=checkbox]')].map(el=>{const r=el.getBoundingClientRect(),s=textBounds(el),p=el.parentElement.getBoundingClientRect();return {name:el.name,width:r.width,height:r.height,padding:parseFloat(getComputedStyle(el).paddingLeft),gap:s.left-r.right,centers:Math.abs(r.y+r.height/2-s.y-s.height/2),fits:s.right<=p.right+.5}})})()`);
      expect(notifications.map((c) => c.name)).toEqual([
        "notify.toast",
        "notify.os",
        "notify.sound",
        "notify.badge",
      ]);
      for (const c of notifications) {
        expect(c.width).toBeGreaterThan(0);
        expect(c.width).toBeLessThanOrEqual(18);
        expect(c.height).toBeGreaterThan(0);
        expect(c.height).toBeLessThanOrEqual(18);
        expect(c.padding).toBe(0);
        expect(c.gap).toBeGreaterThanOrEqual(9.7);
        expect(c.gap).toBeLessThanOrEqual(15);
        expect(c.centers).toBeLessThanOrEqual(.5);
        expect(c.fits).toBe(true);
      }
      await shot(`native-settings-controls-${theme.id}`);
      await page.locator(".otk-settings .otk-view-header button").click();
    }
  });
}
