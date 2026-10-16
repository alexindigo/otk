// SPDX-License-Identifier: LGPL-3.0-only
import dark from "./otk-dark.json" with { type: "json" };
import light from "./otk-light.json" with { type: "json" };
import stone from "./otk-light-stone.json" with { type: "json" };
import type { Theme } from "../../theme/slots.ts";
import type { ThemeRegistry } from "../../theme/registry.ts";
/** Feature-owned shipped palette data, explicitly selected by the consumer. */
export function registerOtkThemes(themes: ThemeRegistry): () => void {
  const releases = [dark, light, stone].map((theme) =>
    themes.register(theme as Theme, { base: theme !== stone })
  );
  return () => releases.reverse().forEach((release) => release());
}
