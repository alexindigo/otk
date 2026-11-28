// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import type { DeliveryScan } from "@otk/harness";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { taskEnvelope } from "./tool-results.ts";

export interface Receipt {
  childID: string;
  receipt: string;
  received: number;
  started?: number;
}
/** Legacy envelope payload is classified and discarded inside the worker. */
export function deliveryReceipt(
  raw: Record<string, unknown>,
  receipt: string,
  received: number,
): Receipt | undefined {
  const state = raw.state as {
    status?: string;
    output?: string;
    metadata?: { sessionId?: string };
    time?: { start?: number; end?: number };
  } | undefined;
  const envelope = taskEnvelope(
    String(
      raw.type === "text" && raw.synthetic === true
        ? raw.text ?? ""
        : state?.output ?? "",
    ),
  );
  if (!envelope || envelope.state === "running") return;
  if (raw.type === "text" && raw.synthetic === true && received > 0) {
    return { childID: envelope.sessionID, receipt, received };
  }
  if (
    raw.type !== "tool" || raw.tool !== "task" ||
    state?.status !== "completed" || envelope.state !== "completed" ||
    state.metadata?.sessionId !== envelope.sessionID || !state.time?.start ||
    !state.time.end || state.time.end < state.time.start
  ) return;
  return {
    childID: envelope.sessionID,
    receipt,
    received: state.time.end,
    started: state.time.start,
  };
}
export function scanDeliveries(
  db: Pick<DatabaseSync, "prepare">,
  parentID: string,
  cursor: string,
  limit: number,
): DeliveryScan {
  const parent = ids.decode(parentID);
  const rows = db.prepare(`SELECT p.id,m.time_created AS received,
    CASE WHEN json_valid(p.data) THEN json_object('type',json_extract(p.data,'$.type'),'tool',json_extract(p.data,'$.tool'),'synthetic',json_extract(p.data,'$.synthetic'),'text',CASE WHEN json_extract(p.data,'$.type')='text' AND json_extract(p.data,'$.synthetic')=1 THEN json_extract(p.data,'$.text') END,'state',CASE WHEN json_extract(p.data,'$.tool')='task' THEN json_object('status',json_extract(p.data,'$.state.status'),'output',json_extract(p.data,'$.state.output'),'metadata',json_object('sessionId',json_extract(p.data,'$.state.metadata.sessionId')),'time',json_object('start',json_extract(p.data,'$.state.time.start'),'end',json_extract(p.data,'$.state.time.end'))) END) ELSE '{}' END AS scalar
    FROM part p JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id
    WHERE p.session_id=? AND p.id>? ORDER BY p.id LIMIT ?`)
    .all(parent, cursor, limit);
  const receipts = rows.map((r) => {
    const scalar = JSON.parse(String(r.scalar));
    // SQLite JSON stores booleans as integer scalar projections.
    if (scalar.synthetic === 1) scalar.synthetic = true;
    return deliveryReceipt(scalar, String(r.id), Number(r.received));
  }).filter((r): r is Receipt => !!r);
  const terminal =
    "CASE WHEN json_extract(m.data,'$.error') IS NOT NULL THEN coalesce(json_extract(m.data,'$.time.completed'),m.time_created) ELSE json_extract(m.data,'$.time.completed') END";
  const ended =
    "json_valid(m.data) AND json_extract(m.data,'$.role')='assistant' AND (json_extract(m.data,'$.error') IS NOT NULL OR (json_extract(m.data,'$.time.completed')>0 AND coalesce(json_extract(m.data,'$.finish'),'') NOT IN ('tool-calls','unknown')))";
  const children = db.prepare(
    `WITH terminals AS (
      SELECT wanted.key AS receipt_index,s.id,s.parent_id,
        (SELECT max(${terminal}) FROM message m WHERE m.session_id=s.id AND ${ended} AND (${terminal})<=json_extract(wanted.value,'$.received')) AS terminal
      FROM json_each(?) wanted JOIN session s ON json_extract(wanted.value,'$.childID')=s.id
    ) SELECT t.*,(SELECT CASE WHEN count(*)=1 THEN min(m.id) END FROM message m WHERE m.session_id=t.id AND ${ended} AND (${terminal})=t.terminal) AS run_id FROM terminals t`,
  ).all(JSON.stringify(receipts));
  const updates: DeliveryScan["updates"] = [];
  for (const [index, receipt] of receipts.entries()) {
    const child = children.find((c) => Number(c.receipt_index) === index),
      token = Number(child?.terminal);
    if (
      !child || child.parent_id !== parent || !token || token > receipt.received
    ) continue;
    if (receipt.started !== undefined && token < receipt.started) continue;
    if (typeof child.run_id !== "string" || !child.run_id) continue;
    updates.push({
      id: ids.encode(receipt.childID),
      delivered: {
        parentID,
        receipt: receipt.receipt,
        terminal: token,
        runID: child.run_id,
      },
    });
  }
  return {
    updates,
    complete: rows.length < limit,
    cursor: rows.length ? String(rows.at(-1)!.id) : cursor,
  };
}
