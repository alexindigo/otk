// SPDX-License-Identifier: LGPL-3.0-only
import { readFile } from "node:fs/promises";
import { expect, test } from "../../fixtures/evidence.ts";
import { labelTextBounds } from "../../../support/control-geometry.ts";
const tags = { tag: ["@visual", "@contracts"] };
test(
  "visual.hidden-native-controls-remove-and-restore-layout-semantics",
  tags,
  async ({ page }) => {
    const css = await readFile(
      new URL("../../../../packages/ui/theme.css", import.meta.url),
      "utf8",
    );
    await page.setContent(
      `<style>${css}</style><button id="action" class="otk-pill" hidden>Unavailable action</button><div id="group" class="otk-control-row" hidden><button>Unavailable group</button></div><button id="available">Available action</button>`,
    );
    const hidden = () =>
      page.locator("[hidden]").evaluateAll((els) =>
        els.map(
          (el) => [
            el.id,
            getComputedStyle(el).display,
            el.getClientRects().length,
          ],
        )
      );
    expect(await hidden()).toEqual([["action", "none", 0], [
      "group",
      "none",
      0,
    ]]);
    await page.evaluate(() => {
      for (const id of ["action", "group"]) {
        document.getElementById(id)!.hidden = false;
      }
    });
    await expect(
      page.getByRole("button", { name: "Unavailable action", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Unavailable group", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      for (const id of ["action", "group"]) {
        document.getElementById(id)!.hidden = true;
      }
    });
    expect(await hidden()).toEqual([["action", "none", 0], [
      "group",
      "none",
      0,
    ]]);
  },
);
test(
  "visual.native-field-compact-hitboxes-without-consumer-overrides",
  tags,
  async ({ page }) => {
    const css = await readFile(
        new URL("../../../../packages/ui/theme.css", import.meta.url),
        "utf8",
      ),
      theme = JSON.parse(
        await readFile(
          new URL(
            "../../../../packages/ui/features/theme/otk-dark.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    const fields = [
        "",
        "unknown",
        "text",
        "SEARCH",
        "tel",
        "url",
        "email",
        "password",
        "number",
        "date",
        "datetime-local",
        "month",
        "week",
        "time",
      ],
      compact = [
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
    const controls = compact.map((type, i) =>
      `<label style="display:flex;align-items:center;gap:10px"><input data-compact="${i}" type="${type}" ${
        type === "image"
          ? "alt=\"Image\" src=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3C/svg%3E\""
          : ""
      }><span>Pick</span></label>`
    ).join("");
    await page.setContent(
      `<style>${css}</style><main style="width:320px">${
        fields.map((type, i) =>
          `<input data-field="${i}" ${type ? `type="${type}"` : ""}>`
        ).join("")
      }<textarea data-field="area"></textarea><select data-field="select"><option>Choice</option></select>${controls}<input type="hidden"><div id="native"></div></main>`,
    );
    const representations = await page.evaluate<
      { before: unknown; direct: unknown }
    >(
      `(()=>{const bounds=${labelTextBounds},field=document.querySelector('[data-compact="0"]'),span=field.nextElementSibling,text=document.createTextNode(span.textContent),before=bounds(field);span.replaceWith(text);const direct=bounds(field);text.replaceWith(span);return {before,direct};})()`,
    );
    expect(representations.direct).toEqual(representations.before);
    await page.evaluate(({ controls, colors }) => {
      const root = document.documentElement;
      for (const [name, value] of Object.entries(colors)) {
        root.style.setProperty("--otk-" + name, String(value));
      }
      root.style.colorScheme = "dark";
      const shadow = document.querySelector("#native")!.attachShadow({
        mode: "open",
      });
      shadow.innerHTML = controls;
      for (const el of Array.from(shadow.querySelectorAll("input"))) {
        el.style.font = "inherit";
        el.style.color = "inherit";
        el.style.boxSizing = "border-box";
      }
    }, { controls, colors: theme.colors });
    for (const width of [320, 920]) {
      await page.locator("main").evaluate(
        (el, w) => el.style.width = w + "px",
        width,
      );
      const result = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement),
          shadow = document.querySelector("#native")!.shadowRoot!;
        const probe = document.createElement("div");
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
          hidden: document.querySelector("input[type=hidden]")!
            .getBoundingClientRect().width,
          fields: Array.from(document.querySelectorAll("[data-field]")).map(
            (el) => {
              const c = getComputedStyle(el);
              return {
                width: el.getBoundingClientRect().width,
                padding: parseFloat(c.paddingLeft),
                bg: c.backgroundColor,
                border: c.borderTopColor,
                font: c.fontFamily,
                color: c.color,
              };
            },
          ),
          compact: Array.from(document.querySelectorAll("main > label input"))
            .map(
              (el, i) => {
                const r = el.getBoundingClientRect(),
                  row = el.parentElement!.getBoundingClientRect(),
                  label = el.nextElementSibling!.getBoundingClientRect(),
                  native = shadow.querySelector(`[data-compact="${i}"]`)!,
                  n = native.getBoundingClientRect(),
                  nl = native.nextElementSibling!.getBoundingClientRect(),
                  c = getComputedStyle(el);
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
      });
      for (const field of result.fields) {
        expect(field.width).toBe(width);
        expect(Math.abs(field.padding - 8)).toBeLessThan(.05);
        expect(field.bg).toBe(result.bg);
        expect(field.border).toBe(result.border);
        expect(field.font).toBe(result.font);
        expect(field.color).toBe(result.color);
      }
      for (const c of result.compact) {
        expect(Math.abs(c.width - c.nativeWidth)).toBeLessThan(.1);
        expect(Math.abs(c.height - c.nativeHeight)).toBeLessThan(.1);
        expect(c.gap).toBeGreaterThanOrEqual(10);
        expect(c.gap).toBeLessThanOrEqual(15);
        expect(Math.abs(c.centers - c.nativeCenters)).toBeLessThanOrEqual(.5);
        expect(c.right).toBeLessThanOrEqual(c.rowRight + .5);
        expect(c.font).toBe(result.font);
        expect(c.color).toBe(result.color);
      }
      expect(result.hidden).toBe(0);
    }
    await page.locator('main > label [data-compact="0"]').click();
    await expect(page.locator('main > label [data-compact="0"]')).toBeChecked();
    await page.locator('main > label [data-compact="1"]').click();
    await expect(page.locator('main > label [data-compact="1"]')).toBeChecked();
  },
);
