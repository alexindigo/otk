// SPDX-License-Identifier: LGPL-3.0-only
import {
  type Theme,
  THEME_SLOTS,
  type ThemeColors,
  type ThemeMode,
} from "./slots.ts";
/** Consumer-selected data and complete mode bases; no concrete theme imports. */
export class ThemeRegistry {
  #themes = new Map<string, Theme>();
  #bases = new Map<ThemeMode, string>();
  register(theme: Theme, options: { base?: boolean } = {}): () => void {
    if (
      !theme.id || theme.id === "system" ||
      this.#themes.has(theme.id)
    ) {
      throw new Error(`Duplicate or reserved theme: ${theme.id}`);
    }
    if (theme.mode !== "dark" && theme.mode !== "light") {
      throw new Error(`Invalid theme mode: ${theme.mode}`);
    }
    for (const [slot, color] of Object.entries(theme.colors)) {
      if (!THEME_SLOTS.includes(slot as typeof THEME_SLOTS[number]) || !color) {
        throw new Error(`Invalid theme slot: ${slot}`);
      }
    }
    if (options.base) {
      if (this.#bases.has(theme.mode)) {
        throw new Error(`Duplicate ${theme.mode} base`);
      }
      if (THEME_SLOTS.some((slot) => !theme.colors[slot])) {
        throw new Error(`Incomplete ${theme.mode} base`);
      }
    }
    const data = Object.freeze({
      ...theme,
      colors: Object.freeze({ ...theme.colors }),
    });
    this.#themes.set(data.id, data);
    if (options.base) this.#bases.set(data.mode, data.id);
    return () => {
      if (this.#themes.get(data.id) !== data) return;
      this.#themes.delete(data.id);
      if (this.#bases.get(data.mode) === data.id) {
        this.#bases.delete(data.mode);
      }
    };
  }
  list(): readonly Theme[] {
    return [...this.#themes.values()];
  }
  resolve(
    id: string,
    system: ThemeMode,
    systemLight?: string,
  ): { id: string; mode: ThemeMode; colors: ThemeColors } {
    const light = systemLight && this.#themes.get(systemLight);
    const systemId = system === "light" && light && light.mode === "light"
      ? light.id
      : this.#bases.get(system);
    const theme = this.#themes.get(
      id === "system" ? systemId! : id,
    ) ?? this.#themes.get(this.#bases.get("dark")!);
    if (!theme) throw new Error(`Missing theme base for: ${id}`);
    const base = this.#themes.get(this.#bases.get(theme.mode)!);
    if (!base) throw new Error(`Missing ${theme.mode} base`);
    return {
      id,
      mode: theme.mode,
      colors: { ...base.colors, ...theme.colors } as ThemeColors,
    };
  }
}
