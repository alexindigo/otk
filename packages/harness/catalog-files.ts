// SPDX-License-Identifier: LGPL-3.0-only
import { dirname, isAbsolute, relative } from "@std/path";
import type { CatalogFileListing } from "./catalog-reads.ts";
import type { ProviderReadPort } from "./provider-reads.ts";
import type { CatalogFile } from "@otk/protocol";

/** Directory-listing tree, owned only by the volatile catalog resource. */
export class CatalogFiles {
  #listings = new Map<string, CatalogFileListing>();
  #dirty = new Set<string>();
  #full = false;
  constructor(
    readonly directory: string,
    readonly reads: ProviderReadPort,
    readonly owner: string,
    readonly pending: number,
  ) {}
  invalidate(paths?: readonly string[]): void {
    if (!paths) {
      this.#full = true;
      this.#dirty.clear();
      this.#dirty.add("");
      return;
    }
    for (const path of paths) {
      const local = relative(this.directory, path);
      if (local === ".." || local.startsWith("../") || isAbsolute(local)) {
        continue;
      }
      // A changed directory entry belongs to its parent's typed listing.
      let parent = local.slice(0, Math.max(0, local.lastIndexOf("/")));
      // Unknown/ignored descendants reconcile through their nearest known parent.
      while (parent && !this.#listings.has(parent)) {
        parent = parent.slice(0, Math.max(0, parent.lastIndexOf("/")));
      }
      this.#dirty.add(parent);
      if (this.#dirty.size > this.pending) {
        this.#dirty.clear();
        this.#dirty.add("");
        this.#full = true;
        break;
      }
    }
  }
  async read(signal: AbortSignal): Promise<CatalogFile[]> {
    const staged = new Map(this.#listings);
    const dirty = this.#dirty.size ? [...this.#dirty] : staged.size ? [] : [""];
    const full = this.#full;
    this.#full = false;
    this.#dirty.clear();
    const queue = [...dirty].sort((a, b) => a.length - b.length),
      physical = new Set<string>();
    const scheduled = new Set(queue);
    if (full) staged.clear();
    try {
      for (let i = 0; i < queue.length; i++) {
        const path = queue[i];
        if (path) {
          const parent = dirname(path);
          if (
            !staged.get(parent === "." ? "" : parent)?.items.some((item) =>
              item.directory && item.path === path
            )
          ) continue;
        }
        const listing = await this.reads.read("catalog.files", {
          directory: this.directory,
          path,
        }, { owner: this.owner, priority: "visible", signal });
        signal.throwIfAborted();
        if (physical.has(listing.physical)) {
          staged.delete(path);
          continue;
        }
        physical.add(listing.physical);
        const previous = staged.get(path);
        staged.set(path, listing);
        const children = new Set(
          listing.items.filter((item) => item.directory).map((item) =>
            item.path
          ),
        );
        for (const item of previous?.items ?? []) {
          if (item.directory && !children.has(item.path)) {
            for (const key of staged.keys()) {
              if (key === item.path || key.startsWith(item.path + "/")) {
                staged.delete(key);
              }
            }
          }
        }
        for (const child of children) {
          if (!staged.has(child) && !scheduled.has(child)) {
            scheduled.add(child);
            queue.push(child);
          }
        }
      }
      this.#listings = staged;
      const result = new Map<string, CatalogFile>();
      for (const listing of staged.values()) {
        for (const item of listing.items) {
          result.set(item.canonicalPath, item);
        }
      }
      return [...result.values()].sort((a, b) => a.path.localeCompare(b.path));
    } catch (error) {
      this.#full ||= full;
      for (const path of dirty) this.#dirty.add(path);
      throw error;
    }
  }
}
