// SPDX-License-Identifier: LGPL-3.0-only
import { relative } from "@std/path";

// Both adapters compose this owner in the serving isolate, never in a worker.
// Each admission creates at most one non-recursive kernel watch.
export const FILE_WATCH_LIMIT = 32;
let used = 0;

export function excludedCatalogPath(path: string): boolean {
  return /(?:^|[/\\])(?:\.git|node_modules)(?:[/\\]|$)/.test(path);
}

export class CatalogFileWatch {
  #entries = new Map<string, () => void>();
  #closed = false;
  #degraded = false;

  constructor(
    readonly root: string,
    readonly invalidate: (paths?: readonly string[]) => void,
    readonly track: (work: Promise<void>) => void,
    readonly diagnostic?: (cause: unknown) => void,
    readonly watch: (paths: readonly string[]) => Deno.FsWatcher = (paths) =>
      Deno.watchFs([...paths], { recursive: false }),
  ) {}

  get degraded(): boolean {
    return this.#degraded;
  }

  add(path: string): void {
    if (this.#closed || this.#degraded || this.#entries.has(path)) return;
    this.#open(path, false);
  }

  prune(paths: Iterable<string>): void {
    const current = new Set(paths);
    for (const [path, close] of this.#entries) {
      if (!current.has(path)) close();
    }
  }

  close(): void {
    this.#closed = true;
    for (const close of this.#entries.values()) close();
  }

  #degrade(): void {
    this.#degraded = true;
    this.close();
  }

  #open(path: string, retry: boolean): void {
    if (used >= FILE_WATCH_LIMIT || excludedCatalogPath(path)) {
      this.#degrade();
      return;
    }
    let watcher: Deno.FsWatcher;
    try {
      watcher = this.watch([path]);
    } catch (cause) {
      this.diagnostic?.(cause);
      this.#degrade();
      return;
    }
    used++;
    const close = () => {
      if (this.#entries.get(path) !== close) return;
      this.#entries.delete(path);
      try {
        watcher.close();
      } finally {
        used--;
      }
    };
    this.#entries.set(path, close);
    this.track((async () => {
      try {
        for await (const event of watcher) {
          if (this.#entries.get(path) !== close) return;
          if (event.kind === "access") continue;
          const paths = event.paths.filter((entry) =>
            !excludedCatalogPath(relative(this.root, entry))
          );
          if (
            event.kind === "other" ||
            paths.some((entry) =>
              /(?:^|[/\\])(?:\.gitignore|\.ignore)$/.test(entry)
            )
          ) this.invalidate();
          else if (paths.length) this.invalidate(paths);
        }
        if (this.#entries.get(path) !== close) return;
        throw new Error("File watch ended before its demand lifetime");
      } catch (cause) {
        if (this.#entries.get(path) !== close) return;
        this.diagnostic?.(cause);
        close();
        if (retry) this.#degrade();
        else this.#open(path, true);
        this.invalidate();
      } finally {
        close();
      }
    })());
  }
}
