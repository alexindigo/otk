// SPDX-License-Identifier: LGPL-3.0-only
import type { RawPart } from "./types.ts";
import type { DatabaseSync } from "node:sqlite";
import { opencodeV1SessionID as ids } from "./ids.ts";
/** Explicit transient scalar read, borrowing the worker's native connection. */
export function readMessageClock(
  database: Pick<DatabaseSync, "prepare">,
  sessionID: string,
  messageID: string,
): { lastOutput: number | null } {
  const row = database.prepare(`SELECT MAX(clock) AS lastOutput FROM (
    SELECT CASE json_extract(p.data,'$.type')
      WHEN 'text' THEN json_extract(p.data,'$.time.end')
      WHEN 'reasoning' THEN json_extract(p.data,'$.time.end')
      WHEN 'tool' THEN json_extract(p.data,'$.state.time.end') END AS clock
    FROM part p WHERE p.session_id=? AND p.message_id=? AND json_valid(p.data)
  ) WHERE typeof(clock) IN ('integer','real') AND clock>0`).get(
    ids.decode(sessionID),
    messageID,
  );
  return {
    lastOutput: typeof row?.lastOutput === "number" ? row.lastOutput : null,
  };
}
/** Scalar extraction only: no message mapping, Markdown or retained parts. */
export function messageOutput(
  parts: readonly RawPart[],
): { lastOutput: number | null } {
  let lastOutput: number | null = null;
  for (const part of parts) {
    const value = part.type === "text" || part.type === "reasoning"
      ? part.time?.end
      : part.type === "tool"
      ? part.state?.time?.end
      : undefined;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      lastOutput = Math.max(lastOutput ?? 0, value);
    }
  }
  return { lastOutput };
}
