// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HarnessError("params", "Expected object");
  }
  return value as Record<string, unknown>;
}
export function text(
  params: Record<string, unknown>,
  key: string,
  optional = false,
): string | undefined {
  const value = params[key];
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || (!optional && value.length === 0)) {
    throw new HarnessError("params", `Expected ${key} string`);
  }
  return value;
}
