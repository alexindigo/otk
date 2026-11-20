// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import type { DeliveryScan } from "@otk/harness";
import { millis, record, text } from "./map.ts";
import { opencodeV2SessionID as ids, optionalSessionID } from "./ids.ts";
import { interpretTool, toolScalarSQL } from "./tool-interpretation.ts";

export interface Receipt {
  childID: string;
  receipt: string;
  received: number;
  started?: number;
}
/** Only materialized parent results qualify. Enqueue/job state is not input. */
export function deliveryReceipt(
  value: unknown,
  receipt: string,
  received: number,
): Receipt | undefined {
  const raw = record(value), meta = record(raw.metadata);
  if (raw.type === "synthetic") {
    const childID = text(meta.childID);
    if (
      meta.source === "subagent" &&
      ["completed", "error", "cancelled"].includes(String(meta.state)) &&
      childID && optionalSessionID(childID) && received > 0
    ) {
      return { childID, receipt, received };
    }
    return;
  }
  const state = record(raw.state), time = record(raw.time);
  const tool = interpretTool(String(raw.name), state.input, state.metadata);
  const hasResult = state.resultReceived === 1 ||
    Array.isArray(state.content) &&
      state.content.some((part) =>
        record(part).type === "text" && typeof record(part).text === "string"
      );
  const completed = millis(time.completed),
    started = millis(time.ran ?? time.created);
  if (
    raw.type === "tool" && tool.name === "task" && hasResult &&
    state.status === "completed" && tool.metadata.status === "completed" &&
    tool.child && optionalSessionID(tool.child) && completed > 0 &&
    started > 0 && completed >= started
  ) {
    return { childID: tool.child, receipt, received: completed, started };
  }
}

function deliveryToolSQL(data: string): string {
  return `json_set(${
    toolScalarSQL(data)
  },'$.state.resultReceived',CASE WHEN json_type(${data},'$.state.content')='array' AND EXISTS(SELECT 1 FROM json_each(${data},'$.state.content') result WHERE json_extract(result.value,'$.type')='text' AND json_type(result.value,'$.text')='text') THEN 1 ELSE 0 END)`;
}

/** Bounded native keyset; split and legacy-inline calls share the same codec.
 * Only scalar metadata leaves SQL; no tool output or synthetic text is read. */
export function scanDeliveries(
  db: Pick<DatabaseSync, "prepare">,
  parentID: string,
  cursor: string,
  limit: number,
): DeliveryScan {
  const parent = ids.decode(parentID);
  const [seq, ordinal] = cursor
    ? JSON.parse(cursor) as [number, number]
    : [-1, -2];
  const keys = db.prepare(
    `SELECT seq FROM session_message WHERE session_id=? AND seq${
      ordinal === Number.MAX_SAFE_INTEGER ? ">" : ">="
    }? ORDER BY seq LIMIT ?`,
  ).all(parent, seq, limit);
  if (!keys.length) return { updates: [], complete: true, cursor };
  const upper = Number(keys.at(-1)!.seq);
  const split = db.prepare("PRAGMA table_info(session_part)").all().some((r) =>
    r.name === "session_id"
  );
  const rows = db.prepare(
    `WITH bounded AS (SELECT * FROM session_message WHERE session_id=? AND seq>=? AND seq<=?), candidates AS (
    SELECT m.seq,-1 AS ordinal,m.id AS receipt,m.time_created AS received,json_object('type','synthetic','metadata',json_extract(m.data,'$.metadata')) AS scalar
    FROM bounded m WHERE m.type='synthetic' AND json_valid(m.data) AND json_extract(m.data,'$.metadata.source')='subagent'
    UNION ALL
    SELECT m.seq,CAST(p.key AS INTEGER)*2,m.id||':'||json_extract(p.value,'$.id'),m.time_created,${
      deliveryToolSQL("p.value")
    }
    FROM bounded m,json_each(CASE WHEN json_valid(m.data) THEN m.data ELSE '{}' END,'$.content') p
    WHERE json_extract(p.value,'$.type')='tool' AND json_extract(p.value,'$.name') IN ('subagent','task')
    ${
      split
        ? `UNION ALL SELECT m.seq,p.ordinal*2+1,m.id||':'||json_extract(p.data,'$.id'),m.time_created,${
          deliveryToolSQL("p.data")
        } FROM session_part p JOIN bounded m ON m.session_id=p.session_id AND m.id=p.message_id WHERE p.session_id=? AND p.type='tool' AND json_valid(p.data) AND json_extract(p.data,'$.name') IN ('subagent','task')`
        : ""
    }
  ) SELECT * FROM candidates WHERE (seq,ordinal)>(?,?) ORDER BY seq,ordinal LIMIT ?`,
  )
    .all(
      parent,
      Number(keys[0].seq),
      upper,
      ...(split ? [parent] : []),
      seq,
      ordinal,
      limit,
    );
  const receipts = rows.map((r) =>
    deliveryReceipt(
      JSON.parse(String(r.scalar)),
      String(r.receipt),
      Number(r.received),
    )
  ).filter((r): r is Receipt => !!r);
  const children = db.prepare(
    `WITH terminals AS (
      SELECT wanted.key AS receipt_index,s.id,s.parent_id,
        (SELECT max(m.time_created) FROM session_message m WHERE m.session_id=s.id AND m.type='idle' AND m.time_created<=json_extract(wanted.value,'$.received') AND json_valid(m.data) AND json_extract(m.data,'$.outcome') IN ('succeeded','failed','interrupted')) AS terminal
      FROM json_each(?) wanted JOIN session_v2 s ON json_extract(wanted.value,'$.childID')=s.id
    ) SELECT t.*,(SELECT count(*) FROM session_message m WHERE m.session_id=t.id AND m.type='idle' AND m.time_created=t.terminal AND json_valid(m.data) AND json_extract(m.data,'$.outcome') IN ('succeeded','failed','interrupted')) AS matching FROM terminals t`,
  ).all(
    JSON.stringify(receipts),
  );
  const updates: DeliveryScan["updates"] = [];
  for (const [index, receipt] of receipts.entries()) {
    const child = children.find((c) => Number(c.receipt_index) === index);
    const terminal = Number(child?.terminal);
    if (
      !child || child.parent_id !== parent || !terminal ||
      terminal > receipt.received
    ) continue;
    // Receipt order covers the latest proven terminal at or before receipt,
    // never a newer run. Equal-clock native terminals remain ambiguous.
    if (receipt.started !== undefined && terminal < receipt.started) continue;
    if (Number(child.matching) !== 1) continue;
    updates.push({
      id: ids.encode(receipt.childID),
      delivered: { parentID, receipt: receipt.receipt, terminal },
    });
  }
  const last = rows.at(-1);
  return {
    updates,
    complete: keys.length < limit && rows.length < limit,
    cursor: rows.length === limit && last
      ? JSON.stringify([last.seq, last.ordinal])
      : JSON.stringify([upper, Number.MAX_SAFE_INTEGER]),
  };
}
