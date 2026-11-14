// SPDX-License-Identifier: LGPL-3.0-only
/** Opaque plugin-owned values. The host supplies an isolated namespace, never
 * interprets a value, and joins writes through its existing SQLite owner. */
export interface PluginStorage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  scan(
    input: { prefix: string; after?: string; limit: number },
  ): { key: string; value: string }[];
  transaction<T>(run: () => T): T;
}
