// SPDX-License-Identifier: LGPL-3.0-only
/** Common metadata validation and notification mechanics, independent of policy. */
export function key(value: string): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > 4096 ||
    value.includes("\0")
  ) {
    throw new Error("Invalid metadata key");
  }
  return value;
}
export function ordered(values: string[]): string[] {
  if (!Array.isArray(values) || new Set(values).size !== values.length) {
    throw new Error("Expected unique ordered keys");
  }
  return values.map(key);
}
export class MetadataChanges {
  #listeners = new Set<() => void>();
  listen(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  protected changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
