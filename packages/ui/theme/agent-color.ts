// SPDX-License-Identifier: LGPL-3.0-only
import type { AgentColor } from "@otk/protocol";

/** Resolve neutral backend colour data only at the CSS presentation boundary. */
export function agentColor(color?: AgentColor): string | undefined {
  return color === "accent"
    ? "var(--accent)"
    : color === "secondary"
    ? "var(--secondary)"
    : color;
}
