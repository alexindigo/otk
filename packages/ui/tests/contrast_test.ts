// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { registerOtkThemes } from "../features/theme/otk.ts";
import { ThemeRegistry } from "../theme/registry.ts";
import { THEME_SLOTS } from "../theme/slots.ts";

type Rgb = [number, number, number];
function rgb(hex: string): Rgb {
  assert(/^#[\da-f]{6}([\da-f]{2})?$/i.test(hex), `Expected sRGB hex: ${hex}`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
}
function over(hex: string, bg: Rgb): Rgb {
  const alpha = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
  return rgb(hex).map((c, i) => c * alpha + bg[i] * (1 - alpha)) as Rgb;
}
function luminance(color: Rgb): number {
  return color.map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
}
function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
const text = THEME_SLOTS.filter((slot) =>
  /^(fg($|-)|age-|code-|agent-)/.test(slot) ||
  [
    "accent-text",
    "status-retry",
    "status-error",
    "warning",
    "success",
    "attention",
    "diff-add",
    "diff-del",
  ].includes(slot)
);
const backgrounds = [
  "bg",
  "bg-side",
  "bg-elevated",
  "surface",
  "surface-2",
] as const;
Deno.test("every theme text, CTA, focus, border and constructed lamp pair meets its contrast contract", () => {
  const themes = new ThemeRegistry();
  registerOtkThemes(themes);
  const failures: string[] = [];
  let pairs = 0;
  for (const theme of themes.list()) {
    const colors = themes.resolve(theme.id, theme.mode).colors;
    const check = (name: string, a: Rgb, b: Rgb, minimum: number) => {
      pairs++;
      const ratio = contrast(a, b);
      if (ratio < minimum) {
        failures.push(`${theme.id} ${name}: ${ratio.toFixed(3)} < ${minimum}`);
      }
    };
    for (const surface of backgrounds) {
      for (const hovered of [false, true]) {
        const bg = hovered
          ? over(colors.hover, rgb(colors[surface]))
          : rgb(colors[surface]);
        const label = surface + (hovered ? "+hover" : "");
        for (const token of text) {
          check(`${token}/${label}`, rgb(colors[token]), bg, 4.5);
        }
        for (const token of ["focus", "border", "lamp-rim"] as const) {
          check(`${token}/${label}`, rgb(colors[token]), bg, 3);
        }
        for (const kind of ["add", "del"] as const) {
          const fill = over(colors[`diff-${kind}-bg`], bg);
          for (const token of ["fg", `diff-${kind}`] as const) {
            check(
              `${token}/diff-${kind}-bg/${label}`,
              rgb(colors[token]),
              fill,
              4.5,
            );
          }
        }
      }
    }
    check(
      "accent-on/accent",
      rgb(colors["accent-on"]),
      rgb(colors.accent),
      4.5,
    );
    for (const lamp of ["lamp-red", "lamp-amber", "lamp-green"] as const) {
      check(
        `${lamp}/lamp-socket`,
        rgb(colors[lamp]),
        rgb(colors["lamp-socket"]),
        3,
      );
    }
  }
  assert(pairs > 800, "The complete surface matrix must be exercised");
  assertEquals(failures, []);
});
Deno.test("lamp colours and socket are identical in dark and light", () => {
  const themes = new ThemeRegistry();
  registerOtkThemes(themes);
  const dark = themes.resolve("otk-dark", "dark").colors;
  const light = themes.resolve("otk-light", "light").colors;
  for (
    const token of [
      "lamp-red",
      "lamp-amber",
      "lamp-green",
      "lamp-socket",
    ] as const
  ) assertEquals(light[token], dark[token]);
  assertEquals(dark["lamp-red"], "#ff2e47");
  assertEquals(dark["lamp-amber"], "#ff9f2e");
  assertEquals(dark["lamp-green"], "#30ff85");
});
