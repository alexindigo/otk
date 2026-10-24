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
  "bubble",
  "bg-code",
  "bg-inline-code",
] as const;
Deno.test("every theme text, CTA and focus pair meets its contrast contract on every surface, hover and selection", () => {
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
      for (const state of ["base", "hover", "selected"] as const) {
        const bg = state === "base"
          ? rgb(colors[surface])
          : over(colors[state], rgb(colors[surface]));
        const label = surface + "+" + state;
        for (const token of text) {
          check(`${token}/${label}`, over(colors[token], bg), bg, 4.5);
        }
        // Lines are decorative hairlines in the approved quiet-chrome design;
        // the visible focus indicator owns the interactive-boundary contrast.
        for (const token of ["focus"] as const) {
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
  }
  assert(pairs > 800, "The complete surface matrix must be exercised");
  assertEquals(failures, []);
});
Deno.test("status lamps consume semantic theme paint through the shared role aliases", async () => {
  const css = await Deno.readTextFile(
    new URL("../components/StatusLight.css", import.meta.url),
  );
  const shared = await Deno.readTextFile(
    new URL("../theme.css", import.meta.url),
  );
  assert(
    !/--lamp-color:\s*#/.test(css),
    "The component must not own gel colours",
  );
  for (const state of ["blocked", "finished", "working", "idle"]) {
    assert(css.includes(`--lamp-color: var(--status-light-${state})`));
    assert(
      shared.includes(`--status-light-${state}: var(--otk-lamp-${state})`),
    );
  }
});
Deno.test("every theme's session and connection tokens meet non-text contrast on every surface, hover and selection", () => {
  const themes = new ThemeRegistry();
  registerOtkThemes(themes);
  const lamps = THEME_SLOTS.filter((s) => /^(lamp-|connection-)/.test(s));
  assertEquals(lamps.length, 8);
  for (const theme of themes.list()) {
    const colors = themes.resolve(theme.id, theme.mode).colors;
    for (const token of lamps) {
      let minimum = Infinity;
      for (const surface of backgrounds) {
        for (const state of ["base", "hover", "selected"] as const) {
          const bg = state === "base"
            ? rgb(colors[surface])
            : over(colors[state], rgb(colors[surface]));
          const ratio = contrast(rgb(colors[token]), bg);
          minimum = Math.min(minimum, ratio);
          assert(
            ratio >= 3,
            `${theme.id} ${token}/${surface}+${state}: ${ratio.toFixed(3)} < 3`,
          );
        }
      }
      console.info(
        `${theme.id} ${token} ${colors[token]} minimum ${minimum.toFixed(3)}:1`,
      );
    }
  }
});
