// SPDX-License-Identifier: LGPL-3.0-only
import type { ToolCall } from "@otk/protocol";

/** Neutral failure evidence only; native metadata interpretation stays in adapters. */
export function toolFailure(call: ToolCall): string | undefined {
  if (call.failure) return call.failure.message || "Failed";
  if (call.status === "error") return call.error || "Failed";
  if (call.status === "denied") return call.error || "Denied";
  if (
    call.tool === "bash" && call.exitCode !== undefined && call.exitCode !== 0
  ) {
    return `Exited with code ${call.exitCode}`;
  }
}
