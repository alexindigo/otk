// SPDX-License-Identifier: LGPL-3.0-only
import { Changes } from "../changes.ts";
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
export class MetadataChanges extends Changes<void> {}
