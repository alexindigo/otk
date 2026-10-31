// SPDX-License-Identifier: LGPL-3.0-only
import { Changes } from "../changes.ts";
import type { StoreWrite } from "../db.ts";
/** Common metadata validation and notification mechanics, independent of policy. */
export const MAX_METADATA_KEY = 4096;
export interface KeyPolicy {
  maxLength: number;
  blank: boolean;
  invalid(): Error;
}
export function validateKey(value: string, policy: KeyPolicy): string {
  if (
    typeof value !== "string" || !value.length ||
    (!policy.blank && !value.trim()) || value.length > policy.maxLength ||
    value.includes("\0")
  ) {
    throw policy.invalid();
  }
  return value;
}
export function key(value: string): string {
  return validateKey(value, {
    maxLength: MAX_METADATA_KEY,
    blank: false,
    invalid: () => new Error("Invalid metadata key"),
  });
}
export function ordered(values: string[]): string[] {
  if (!Array.isArray(values) || new Set(values).size !== values.length) {
    throw new Error("Expected unique ordered keys");
  }
  return values.map(key);
}
/** One detached, final value per metadata key and outer write scope. */
export class MetadataChanges<T = void> extends Changes<T> {
  #pending = new WeakMap<StoreWrite, Map<string, { value: T }>>();
  protected changeKey(_value: T): string {
    return "";
  }
  protected mergeChanges(_before: T, after: T): T {
    return after;
  }
  protected override changed(value: T, tx?: StoreWrite): void {
    if (!tx) return super.changed(value);
    const key = this.changeKey(value);
    let pending = this.#pending.get(tx);
    if (!pending) this.#pending.set(tx, pending = new Map());
    const previous = pending.get(key);
    if (previous) {
      previous.value = this.mergeChanges(
        previous.value,
        structuredClone(value),
      );
      return;
    }
    const queued = { value: structuredClone(value) };
    // Queue once, capture the final transaction value without a post-commit read.
    this.queueMetadata(tx, () => super.changed(queued.value));
    pending.set(key, queued);
  }
}

export function mergeRecords<T>(
  before: { upsert: T[]; remove: string[] },
  after: { upsert: T[]; remove: string[] },
  identity: (value: T) => string,
): { upsert: T[]; remove: string[] } {
  const upsert = new Map(
    before.upsert.map((value) => [identity(value), value]),
  );
  const remove = new Set(before.remove);
  for (const id of after.remove) {
    upsert.delete(id);
    remove.add(id);
  }
  for (const value of after.upsert) {
    const id = identity(value);
    remove.delete(id);
    upsert.set(id, value);
  }
  return { upsert: [...upsert.values()], remove: [...remove] };
}
