// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { ThemeRegistry } from "../theme/registry.ts";
import {
  ThemeEngine,
  type ThemeEnvironment,
  type ThemeSnapshot,
} from "../theme/engine.ts";
import { registerOtkThemes } from "../features/theme/otk.ts";
import { THEME_SLOTS, type ThemeMode } from "../theme/slots.ts";

function setup() {
  const themes = new ThemeRegistry();
  registerOtkThemes(themes);
  let system: ThemeMode = "dark",
    change: (() => void) | undefined,
    output: ThemeSnapshot | undefined;
  const environment: ThemeEnvironment = {
    system: () => system,
    watch: (listener) => {
      change = listener;
      return () => {
        change = undefined;
      };
    },
    apply: (theme) => {
      output = theme;
    },
  };
  return {
    themes,
    environment,
    output: () => output,
    os(mode: ThemeMode) {
      system = mode;
      change?.();
    },
    watching: () => !!change,
  };
}
Deno.test("theme partial overrides inherit the selected mode's complete base without cross-mode residue", () => {
  const { themes } = setup();
  themes.register({
    id: "partial-light",
    label: "External light",
    mode: "light",
    colors: { accent: "#123456" },
  });
  themes.register({
    id: "partial-dark",
    label: "External dark",
    mode: "dark",
    colors: { "code-string": "#654321" },
  });
  const light = themes.resolve("partial-light", "dark").colors;
  assertEquals(Object.keys(light).sort(), [...THEME_SLOTS].sort());
  assertEquals(light.bg, themes.resolve("otk-light", "dark").colors.bg);
  assertEquals(
    light["code-comment"],
    themes.resolve("otk-light", "dark").colors["code-comment"],
  );
  assertEquals(light.accent, "#123456");
  const dark = themes.resolve("partial-dark", "light").colors;
  assertEquals(dark.bg, "#1a1c1e");
  assertEquals(dark.accent, "#ff4d00");
  assertEquals(dark["code-string"], "#654321");
});
Deno.test("theme registry owns immutable data, rejects incomplete bases and isolates consumers", () => {
  const { themes } = setup(), other = new ThemeRegistry();
  const colors = { accent: "#123456" };
  const release = themes.register({
    id: "external",
    label: "External",
    mode: "dark",
    colors,
  });
  colors.accent = "#000000";
  assertEquals(themes.resolve("external", "dark").colors.accent, "#123456");
  assertThrows(() => other.resolve("external", "dark"), Error, "Unknown theme");
  assertThrows(() => themes.register(themes.list()[0]), Error, "Duplicate");
  assertThrows(
    () =>
      other.register({ id: "base", label: "Base", mode: "light", colors: {} }, {
        base: true,
      }),
    Error,
    "Incomplete",
  );
  release();
  release();
  assertThrows(
    () => themes.resolve("external", "dark"),
    Error,
    "Unknown theme",
  );
});
Deno.test("preview cancellation restores the newest committed host value and stale owners cannot repaint", () => {
  const f = setup(),
    engine = new ThemeEngine(f.themes, f.environment, "otk-dark");
  const stop = engine.start(), preview = engine.preview();
  preview.select("otk-light");
  assertEquals(f.output()!.mode, "light");
  engine.commit("system");
  assertEquals(f.output()!.committed, "system");
  assertEquals(f.output()!.selected, "otk-light");
  preview.close();
  assertEquals(f.output()!.selected, "system");
  assertEquals(f.output()!.mode, "dark");
  const newer = engine.preview();
  newer.select("otk-light");
  preview.close();
  preview.select("otk-dark");
  assertEquals(f.output()!.selected, "otk-light");
  newer.close();
  stop();
  assertEquals(f.watching(), false);
});
Deno.test("System follows live OS changes including preview and pinned modes retain their paint", () => {
  const f = setup(),
    engine = new ThemeEngine(f.themes, f.environment, "system");
  let observations = 0;
  const release = engine.subscribe(() => observations++), stop = engine.start();
  f.os("light");
  assertEquals(f.output()!.colors.bg, "#f4f6f8");
  assertEquals(f.output()!.committed, "system");
  engine.commit("otk-dark");
  f.os("light");
  assertEquals(f.output()!.colors.bg, "#1a1c1e");
  const preview = engine.preview();
  preview.select("system");
  assertEquals(f.output()!.mode, "light");
  f.os("dark");
  assertEquals(f.output()!.mode, "dark");
  preview.close();
  assertEquals(f.output()!.selected, "otk-dark");
  assertThrows(() => engine.commit("unknown"), Error, "Unknown theme");
  assertEquals(engine.snapshot().committed, "otk-dark");
  assert(observations >= 6);
  release();
  stop();
});
function rgb(hex: string): number[] {
  return [1, 3, 5].map((offset) =>
    parseInt(hex.slice(offset, offset + 2), 16) / 255
  );
}
function luminance(color: number[]): number {
  return color.map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
}
function contrast(fg: string, bg: number[]): number {
  const a = luminance(rgb(fg)), b = luminance(bg);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
Deno.test("OTK Light text including code, statuses and agents has >=4.5:1 contrast on both surfaces and diff fills", () => {
  const { themes } = setup(),
    colors = themes.resolve("otk-light", "dark").colors;
  const text = THEME_SLOTS.filter((slot) =>
    [
      "fg",
      "fg-muted",
      "fg-faint",
      "accent-text",
      "status-retry",
      "status-error",
      "warning",
      "success",
      "attention",
      "diff-add",
      "diff-del",
    ].includes(slot) || slot.startsWith("code-") || slot.startsWith("agent-")
  );
  for (const surface of ["bg", "bg-elevated"] as const) {
    for (const slot of text) {
      assert(
        contrast(colors[slot], rgb(colors[surface])) >= 4.5,
        `${slot} on ${surface}`,
      );
    }
    for (const kind of ["add", "del"] as const) {
      const fill = colors[`diff-${kind}-bg`],
        alpha = parseInt(fill.slice(7), 16) / 255;
      const bg = rgb(fill).map((c, i) =>
        c * alpha + rgb(colors[surface])[i] * (1 - alpha)
      );
      assert(contrast(colors[`diff-${kind}`], bg) >= 4.5, `diff ${kind} sign`);
      assert(contrast(colors.fg, bg) >= 4.5, `diff ${kind} source`);
    }
  }
  assertEquals(colors.accent, "#ff4d00");
});
