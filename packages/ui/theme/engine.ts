// SPDX-License-Identifier: LGPL-3.0-only
import type { ThemeRegistry } from "./registry.ts";
import { THEME_SLOTS, type ThemeColors, type ThemeMode } from "./slots.ts";
export interface ThemeSnapshot {
  readonly committed: string;
  readonly selected: string;
  readonly mode: ThemeMode;
  readonly colors: ThemeColors;
}
export interface ThemeEnvironment {
  system(): ThemeMode;
  watch(change: () => void): () => void;
  apply(theme: ThemeSnapshot): void;
}
/** Browser output only; persistence is an injected host-owned preference. */
export function browserThemeEnvironment(
  doc: Document = document,
): ThemeEnvironment {
  const media = doc.defaultView!.matchMedia("(prefers-color-scheme: dark)");
  return {
    system: () => media.matches ? "dark" : "light",
    watch(change) {
      media.addEventListener("change", change);
      return () => media.removeEventListener("change", change);
    },
    apply(theme) {
      const root = doc.documentElement;
      for (const slot of THEME_SLOTS) {
        root.style.setProperty(`--otk-${slot}`, theme.colors[slot]);
      }
      root.style.colorScheme = theme.mode;
      root.dataset.otkTheme = theme.selected;
      let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (!meta) {
        meta = doc.createElement("meta");
        meta.name = "theme-color";
        doc.head.append(meta);
      }
      meta.content = theme.colors.bg;
    },
  };
}
/** One paint owner. Preview never mutates the latest authoritative commit. */
export class ThemeEngine {
  #committed: string;
  #preview?: { owner: symbol; id: string };
  #listeners = new Set<() => void>();
  #stop?: () => void;
  constructor(
    readonly themes: ThemeRegistry,
    readonly environment: ThemeEnvironment,
    committed: string,
  ) {
    this.#committed = committed;
    this.snapshot();
  }
  snapshot(): ThemeSnapshot {
    const selected = this.#preview?.id ?? this.#committed;
    const resolved = this.themes.resolve(selected, this.environment.system());
    return {
      committed: this.#committed,
      selected,
      mode: resolved.mode,
      colors: resolved.colors,
    };
  }
  start(): () => void {
    if (this.#stop) throw new Error("Theme engine already started");
    const unwatch = this.environment.watch(() => this.#paint());
    const stop = () => {
      unwatch();
      if (this.#stop === stop) this.#stop = undefined;
    };
    this.#stop = stop;
    this.#paint();
    return stop;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  commit(id: string): void {
    this.themes.resolve(id, this.environment.system());
    this.#committed = id;
    this.#paint();
  }
  preview(): { select(id: string): void; close(): void } {
    if (this.#preview) throw new Error("Theme preview already owned");
    const owner = Symbol("theme-preview");
    this.#preview = { owner, id: this.#committed };
    return {
      select: (id) => {
        if (this.#preview?.owner !== owner) return;
        this.themes.resolve(id, this.environment.system());
        this.#preview.id = id;
        this.#paint();
      },
      close: () => {
        if (this.#preview?.owner !== owner) return;
        this.#preview = undefined;
        this.#paint();
      },
    };
  }
  #paint(): void {
    this.environment.apply(this.snapshot());
    for (const listener of this.#listeners) listener();
  }
}
