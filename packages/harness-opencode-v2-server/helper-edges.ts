// SPDX-License-Identifier: LGPL-3.0-only
import type { PluginStorage } from "@otk/harness";
import { optionalSessionID } from "./ids.ts";
import { toolChild } from "./tool-interpretation.ts";

const prefix = (parent: string, message?: string) =>
  `helper-edges/1/${encodeURIComponent(parent)}/` +
  (message === undefined ? "" : `${encodeURIComponent(message)}/`);
const key = (parent: string, message: string, call: string) =>
  prefix(parent, message) + encodeURIComponent(call);

/** Stock V2 stores Tool.Called, but Tool.Progress is ephemeral. Retain only
 * the native edge, never the tool body, child transcript or progress summary. */
export class HelperEdges {
  #storage?: PluginStorage;
  constructor(readonly diagnostic: (cause: unknown) => void) {}

  bind(storage: PluginStorage): void {
    this.#storage = storage;
  }

  #access<T>(run: (storage: PluginStorage) => T): T | undefined {
    if (!this.#storage) return;
    try {
      return run(this.#storage);
    } catch (cause) {
      this.diagnostic(cause);
    }
  }

  observe(parent: string, message: string, call: string, metadata: unknown) {
    const child = optionalSessionID(toolChild(metadata));
    if (!child || child === parent) return;
    this.#access((storage) => {
      const edge = key(parent, message, call);
      if (storage.get(edge) !== child) storage.set(edge, child);
    });
  }

  child(parent: string, message: string, call: string): string | undefined {
    return this.#access((storage) => storage.get(key(parent, message, call)));
  }

  retire(parent: string, message?: string, call?: string): void {
    this.#access((storage) => {
      if (message !== undefined && call !== undefined) {
        const edge = key(parent, message, call);
        if (storage.get(edge) !== undefined) storage.delete(edge);
        return;
      }
      const scope = prefix(parent, message);
      for (;;) {
        const rows = storage.scan({ prefix: scope, limit: 32 });
        if (!rows.length) return;
        storage.transaction(() => {
          for (const row of rows) storage.delete(row.key);
        });
      }
    });
  }
}
