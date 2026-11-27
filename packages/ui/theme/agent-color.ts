// SPDX-License-Identifier: LGPL-3.0-only
import type { AgentColor } from "@otk/protocol";
import { THEME_SLOTS } from "./slots.ts";

/** Resolve neutral backend colour data only at the CSS presentation boundary. */
export function agentColor(color?: AgentColor): string | undefined {
  return color === "accent"
    ? "var(--accent)"
    : color === "secondary"
    ? "var(--secondary)"
    : color;
}

const agentSlots = THEME_SLOTS.filter((slot) => slot.startsWith("agent-"));

/** Stable semantic swatch for an agent identity without explicit colour data. */
export function agentSwatch(agent?: string): string | undefined {
  if (!agent) return;
  let hash = 0;
  for (const character of agent) {
    hash = Math.imul(hash, 31) + character.codePointAt(0)!;
  }
  return `var(--otk-${agentSlots[(hash >>> 0) % agentSlots.length]})`;
}
