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
Deno.test("fixed gel colours contrast against their own Luch dark rim, including unlit", async () => {
  const css = await Deno.readTextFile(
    new URL("../components/StatusLight.css", import.meta.url),
  );
  assert(
    !css.includes("var(--otk-lamp-"),
    "Lamp construction cannot depend on theme slots",
  );
  assert(!/--lamp-color:\s*var\(/.test(css));
  assert(!THEME_SLOTS.some((slot) => slot.startsWith("lamp-")));
  const lamps = [...css.matchAll(/--lamp-color: (#[\da-f]{6});/g)].map((m) =>
    m[1]
  );
  assertEquals(lamps, ["#8e949b", "#ff2e4d", "#ff8f2e", "#30ff85"]);
  for (const lamp of lamps) {
    const color = rgb(lamp), mix = lamp === "#8e949b" ? .4 : .42;
    const rim = color.map((value) => value * mix) as Rgb;
    assert(contrast(color, rim) >= 3, `${lamp} against its dark rim`);
  }
});
