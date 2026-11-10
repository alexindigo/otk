// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import type {
  ProviderReadCodec,
  ProviderReadCodecs,
  TranscriptMetadata,
} from "@otk/harness";
import "./read-kinds.ts";
import type { LatestPrompt, UsageMessage, UsageTool } from "@otk/protocol";
import {
  type MessageContext,
  millis,
  partID,
  record,
  reported,
  text,
  tokens,
} from "./map.ts";
import { type Messages, type NativeMessage, SCAN_ROWS } from "./messages.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";

export interface ScalarMessage {
  id: string;
  type: NativeMessage["type"];
  seq: number;
  created: number;
  completed?: number;
  agent?: string;
  model?: MessageContext["model"];
  usage?: UsageMessage;
}
export interface TranscriptFacts {
  source: string;
  metadata: TranscriptMetadata;
  contexts: Record<string, MessageContext>;
  cutoffOrder?: number;
}
export interface TranscriptInput {
  sessionID: string;
  messages: string[];
  cutoff?: string;
}
export interface PrefetchInput extends TranscriptInput {
  before: string;
  limit: number;
}
export interface PrefetchPage {
  page: import("./messages.ts").NativePage;
  facts: TranscriptFacts;
}
export interface HelperAggregate {
  messageID: string;
  toolCount: number;
  current?: { name: string; title?: string; startedAt: number };
}
/** Transient JSON fragments use the existing credited worker channel. */
function jsonCodec<
  K extends "opcv2.transcript" | "opcv2.message.prefetch",
>(): ProviderReadCodec<K> {
  return {
    *chunks(value) {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      for (let i = 0; i < bytes.length; i += 32768) {
        yield btoa(String.fromCharCode(...bytes.subarray(i, i + 32768)));
      }
    },
    create() {
      const chunks: Uint8Array[] = [];
      return {
        append(value) {
          chunks.push(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
        },
        finish() {
          const bytes = new Uint8Array(
            chunks.reduce((n, v) => n + v.length, 0),
          );
          let at = 0;
          for (const c of chunks) {
            bytes.set(c, at);
            at += c.length;
          }
          return JSON.parse(new TextDecoder().decode(bytes));
        },
      };
    },
  };
}
export const transcriptReadCodecs: ProviderReadCodecs = {
  "opcv2.transcript": jsonCodec<"opcv2.transcript">(),
  "opcv2.message.prefetch": jsonCodec<"opcv2.message.prefetch">(),
};
export function scalarMessage(
  raw: NativeMessage,
  seq: number,
  replyTo?: string,
): ScalarMessage {
  const model = "model" in raw && raw.model ? raw.model : undefined;
  const result: ScalarMessage = {
    id: raw.id,
    type: raw.type,
    seq,
    created: millis(raw.time.created),
    completed: "completed" in raw.time && raw.time.completed
      ? millis(raw.time.completed)
      : undefined,
    agent: "agent" in raw ? raw.agent : undefined,
    model: model
      ? {
        id: model.id,
        providerID: model.providerID,
        variant: model.variant ?? undefined,
      }
      : undefined,
  };
  if (raw.type === "assistant") {
    result.usage = {
      sourceOrder: seq,
      id: raw.id,
      turnID: replyTo ?? raw.id,
      model: { provider: raw.model.providerID, model: raw.model.id },
      tokens: tokens(raw.tokens),
      cost: reported(raw.cost),
      completed: !!raw.time.completed,
      time: { start: result.created, end: result.completed },
    };
  }
  return result;
}
export function factsFrom(
  rows: readonly ScalarMessage[],
  wanted: readonly string[],
  cutoff?: string,
): TranscriptFacts {
  const contexts: TranscriptFacts["contexts"] = {},
    cutoffOrder = rows.find((r) => r.id === cutoff)?.seq;
  let replyTo: string | undefined,
    agent: string | undefined,
    model: MessageContext["model"],
    prompt: LatestPrompt | undefined,
    latestContext: MessageContext | undefined;
  const boundaries = new Map<string, import("@otk/protocol").ReplyBoundary>();
  const selected = new Set(wanted);
  for (const row of rows) {
    if (cutoffOrder !== undefined && row.seq >= cutoffOrder) continue;
    if (row.type === "agent-switched") {
      agent = row.agent;
      if (prompt) prompt.agent = row.agent;
    }
    if (row.type === "model-switched") {
      model = row.model;
      if (prompt) {
        prompt.model = model
          ? { provider: model.providerID, model: model.id }
          : undefined;
        prompt.variant = model?.variant;
      }
    }
    if (row.type === "user") {
      replyTo = row.id;
      prompt = {
        id: row.id,
        agent,
        model: model
          ? { provider: model.providerID, model: model.id }
          : undefined,
        variant: model?.variant,
      };
      latestContext = { order: row.seq, agent, model };
    }
    if (selected.has(row.id)) {
      contexts[row.id] = {
        order: row.seq,
        replyTo: row.type === "assistant" ? replyTo : undefined,
        agent,
        model,
      };
    }
    if (row.type === "assistant") {
      const turnID = replyTo ?? row.id, previous = boundaries.get(turnID);
      boundaries.set(turnID, {
        turnID,
        firstID: previous?.firstID ?? row.id,
        lastID: row.id,
        complete: true,
      });
    }
  }
  if (prompt && latestContext) contexts[prompt.id] ??= latestContext;
  // A session's initial selection is not necessarily a switch message. The
  // first assistant after that user proves its dispatch selection instead.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (
      row.type !== "user" ||
      (cutoffOrder !== undefined && row.seq >= cutoffOrder)
    ) continue;
    let following: ScalarMessage | undefined;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].type === "user") break;
      if (rows[j].type === "assistant") {
        following = rows[j];
        break;
      }
    }
    const ctx = contexts[row.id];
    if (ctx && following) {
      ctx.agent ??= following.agent;
      ctx.model ??= following.model;
    }
    if (prompt?.id === row.id && following) {
      prompt.agent ??= following.agent;
      prompt.model ??= following.model
        ? { provider: following.model.providerID, model: following.model.id }
        : undefined;
      prompt.variant ??= following.model?.variant;
    }
  }
  return {
    source: "api",
    contexts,
    cutoffOrder,
    metadata: {
      prompt,
      boundaries: [...boundaries.values()].filter((b) =>
        wanted.some((id) =>
          contexts[id]?.replyTo === b.turnID || id === b.turnID
        )
      ),
      ...(cutoff
        ? { cutoffCreated: rows.find((r) => r.id === cutoff)?.created }
        : {}),
    },
  };
}
/** Worker-local scalar reader borrows its owner's proven native connection. */
export class TranscriptReads {
  constructor(
    readonly messages: Messages,
    readonly native: () => Pick<DatabaseSync, "prepare"> | undefined,
    readonly yieldRead: (signal: AbortSignal) => Promise<void> = async (
      signal,
    ) => {
      signal.throwIfAborted();
      await new Promise((r) => setTimeout(r, 0));
    },
    readonly source?: () => string,
    readonly observe?: (operation: string) => void,
  ) {}
  sqlHeaders(
    sessionID: string,
    before: number | undefined,
    limit: number,
    only?: readonly string[],
  ): ScalarMessage[] | undefined {
    const sql = this.native();
    if (!sql) return;
    const rows = sql.prepare(`SELECT id,type,seq,time_created,
      json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.time.completed') AS completed,
      json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.agent') AS agent,
      json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.model') AS model,
      json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.cost') AS cost,
      json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.tokens') AS tokens,
      (SELECT u.id FROM session_message u WHERE u.session_id=m.session_id AND u.type='user' AND u.seq<m.seq ORDER BY u.seq DESC LIMIT 1) AS turn_id
      FROM session_message m WHERE session_id=? AND ${
      only === undefined ? "seq<?" : "id IN (SELECT value FROM json_each(?))"
    } ORDER BY seq DESC LIMIT ?`)
      .all(
        ids.decode(sessionID),
        only === undefined
          ? before ?? Number.MAX_SAFE_INTEGER
          : JSON.stringify(only),
        Math.min(SCAN_ROWS, limit),
      );
    return rows.map((r) => {
      const model = r.model ? record(JSON.parse(String(r.model))) : {};
      const row: ScalarMessage = {
        id: String(r.id),
        type: r.type as NativeMessage["type"],
        seq: Number(r.seq),
        created: Number(r.time_created),
        completed: r.completed == null ? undefined : millis(r.completed),
        agent: text(r.agent),
        model:
          typeof model.id === "string" && typeof model.providerID === "string"
            ? {
              id: model.id,
              providerID: model.providerID,
              variant: text(model.variant),
            }
            : undefined,
      };
      if (row.type === "assistant") {
        row.usage = {
          sourceOrder: row.seq,
          id: row.id,
          turnID: text(r.turn_id) ?? row.id,
          model: {
            provider: row.model?.providerID ?? "",
            model: row.model?.id ?? "",
          },
          tokens: tokens(r.tokens ? JSON.parse(String(r.tokens)) : undefined),
          cost: reported(r.cost),
          completed: row.completed !== undefined,
          time: { start: row.created, end: row.completed },
        };
      }
      return row;
    });
  }
  async scan(
    sessionID: string,
    signal: AbortSignal,
    consume: (
      rows: ScalarMessage[],
    ) => boolean | void | Promise<boolean | void>,
  ): Promise<void> {
    let before: number | undefined, cursor: string | undefined, order = 0;
    do {
      signal.throwIfAborted();
      const sql = this.sqlHeaders(sessionID, before, SCAN_ROWS);
      let rows: ScalarMessage[];
      if (sql) {
        rows = sql;
        before = rows.at(-1)?.seq;
      } else {
        const page = await this.messages.page(
          sessionID,
          SCAN_ROWS,
          cursor,
          signal,
        );
        cursor = page.next;
        rows = [...page.items].reverse().map((raw) =>
          scalarMessage(raw, --order)
        );
      }
      const proceed = await consume(rows);
      if (proceed === false) break;
      if (rows.length < SCAN_ROWS || (!sql && !cursor)) break;
      await this.yieldRead(signal);
    } while (true);
  }
  async facts(
    input: TranscriptInput,
    signal: AbortSignal,
  ): Promise<TranscriptFacts> {
    const native = this.sqlFacts(input);
    if (native) return native;
    // Fallback retains only scalar headers. Body pages are discarded on each chunk.
    const rows: ScalarMessage[] = [];
    const wanted = new Set([
      ...input.messages,
      ...(input.cutoff ? [input.cutoff] : []),
    ]);
    let oldest = Infinity;
    await this.scan(input.sessionID, signal, (chunk) => {
      rows.push(...chunk);
      for (const row of chunk) {
        if (wanted.delete(row.id)) oldest = Math.min(oldest, row.seq);
      }
      if (
        !wanted.size &&
        chunk.some((row) => row.type === "user" && row.seq <= oldest)
      ) return false;
    });
    return {
      ...factsFrom(
        rows.sort((a, b) => a.seq - b.seq),
        input.messages,
        input.cutoff,
      ),
      source: this.native()
        ? `api:fallback:${this.source?.() ?? "sql"}`
        : this.source?.() ?? "api",
    };
  }
  sqlFacts(input: TranscriptInput): TranscriptFacts | undefined {
    const sql = this.native();
    if (!sql) return;
    const sid = ids.decode(input.sessionID),
      cutoff = input.cutoff
        ? sql.prepare(
          "SELECT seq,time_created FROM session_message WHERE session_id=? AND id=?",
        ).get(sid, input.cutoff)
        : undefined;
    if (input.cutoff && !cutoff) return;
    const end = cutoff ? Number(cutoff.seq) : Number.MAX_SAFE_INTEGER;
    const latest = sql.prepare(
      "SELECT id,seq FROM session_message WHERE session_id=? AND type='user' AND seq<? ORDER BY seq DESC LIMIT 1",
    ).get(sid, end);
    const wanted = [
      ...new Set([...input.messages, ...(latest ? [String(latest.id)] : [])]),
    ];
    const rows = sql.prepare(`SELECT id,type,seq,
      (SELECT u.id FROM session_message u WHERE u.session_id=m.session_id AND u.type='user' AND u.seq<=m.seq ORDER BY u.seq DESC LIMIT 1) AS user_id,
      (SELECT json_extract(CASE WHEN json_valid(a.data) THEN a.data ELSE '{}' END,'$.agent') FROM session_message a WHERE a.session_id=m.session_id AND a.type='agent-switched' AND a.seq<=m.seq ORDER BY a.seq DESC LIMIT 1) AS agent,
      (SELECT json_extract(CASE WHEN json_valid(a.data) THEN a.data ELSE '{}' END,'$.model') FROM session_message a WHERE a.session_id=m.session_id AND a.type='model-switched' AND a.seq<=m.seq ORDER BY a.seq DESC LIMIT 1) AS model,
      (SELECT json_object('agent',json_extract(a.data,'$.agent'),'model',json_extract(a.data,'$.model')) FROM session_message a WHERE a.session_id=m.session_id AND a.type='assistant' AND a.seq>m.seq AND a.seq<COALESCE((SELECT MIN(u.seq) FROM session_message u WHERE u.session_id=m.session_id AND u.type='user' AND u.seq>m.seq),9223372036854775807) AND json_valid(a.data) ORDER BY a.seq LIMIT 1) AS following
      FROM session_message m WHERE session_id=? AND id IN (SELECT value FROM json_each(?)) AND seq<? ORDER BY seq`)
      .all(sid, JSON.stringify(wanted), end);
    if (
      input.messages.some((id) =>
        !rows.some((r) => r.id === id) && id !== input.cutoff
      )
    ) return;
    const contexts: TranscriptFacts["contexts"] = {};
    for (const row of rows) {
      const following = row.following
          ? record(JSON.parse(String(row.following)))
          : {},
        model = row.model
          ? record(JSON.parse(String(row.model)))
          : record(following.model);
      contexts[String(row.id)] = {
        order: Number(row.seq),
        replyTo: row.type === "assistant" ? text(row.user_id) : undefined,
        agent: text(row.agent) ?? text(following.agent),
        model:
          typeof model.id === "string" && typeof model.providerID === "string"
            ? {
              id: model.id,
              providerID: model.providerID,
              variant: text(model.variant),
            }
            : undefined,
      };
    }
    const boundaries: import("@otk/protocol").ReplyBoundary[] = [];
    const turns = [
      ...new Set(
        [
          ...Object.values(contexts).flatMap((c) =>
            c.replyTo ? [c.replyTo] : []
          ),
          ...rows.filter((r) =>
            r.type === "user" && input.messages.includes(String(r.id))
          ).map((r) => String(r.id)),
        ],
      ),
    ];
    for (const turnID of turns) {
      const user = sql.prepare(
        "SELECT seq FROM session_message WHERE session_id=? AND id=?",
      ).get(sid, turnID);
      if (!user) continue;
      const start = Number(user.seq);
      const next = sql.prepare(
        "SELECT MIN(seq) AS seq FROM session_message WHERE session_id=? AND type='user' AND seq>?",
      ).get(sid, start);
      const limit = Math.min(end, next?.seq == null ? end : Number(next.seq));
      const first = sql.prepare(
          "SELECT id FROM session_message WHERE session_id=? AND type='assistant' AND seq>? AND seq<? ORDER BY seq LIMIT 1",
        ).get(sid, start, limit),
        last = sql.prepare(
          "SELECT id FROM session_message WHERE session_id=? AND type='assistant' AND seq>? AND seq<? ORDER BY seq DESC LIMIT 1",
        ).get(sid, start, limit);
      boundaries.push({
        turnID,
        firstID: first ? String(first.id) : undefined,
        lastID: last ? String(last.id) : undefined,
        complete: true,
      });
    }
    const ctx = latest ? contexts[String(latest.id)] : undefined;
    const selectedAgent = sql.prepare(
      "SELECT json_extract(data,'$.agent') AS agent FROM session_message WHERE session_id=? AND type='agent-switched' AND seq<? AND json_valid(data) ORDER BY seq DESC LIMIT 1",
    ).get(sid, end);
    const selectedModel = sql.prepare(
      "SELECT json_extract(data,'$.model') AS model FROM session_message WHERE session_id=? AND type='model-switched' AND seq<? AND json_valid(data) ORDER BY seq DESC LIMIT 1",
    ).get(sid, end);
    const selection = selectedModel?.model
      ? record(JSON.parse(String(selectedModel.model)))
      : undefined;
    return {
      source: this.source?.() ?? "sql",
      contexts,
      cutoffOrder: cutoff ? Number(cutoff.seq) : undefined,
      metadata: {
        prompt: latest
          ? {
            id: String(latest.id),
            agent: text(selectedAgent?.agent) ?? ctx?.agent,
            model: selection && typeof selection.providerID === "string" &&
                typeof selection.id === "string"
              ? { provider: selection.providerID, model: selection.id }
              : ctx?.model
              ? { provider: ctx.model.providerID, model: ctx.model.id }
              : undefined,
            variant: selection ? text(selection.variant) : ctx?.model?.variant,
          }
          : undefined,
        boundaries,
        cutoffCreated: cutoff ? Number(cutoff.time_created) : undefined,
      },
    };
  }
  async prefetch(
    input: PrefetchInput,
    signal: AbortSignal,
  ): Promise<PrefetchPage> {
    const page = await this.messages.page(
      input.sessionID,
      input.limit,
      input.before,
      signal,
    );
    const facts = await this.facts({
      ...input,
      messages: page.items.map((m) => m.id),
    }, signal);
    return { page, facts };
  }
  /** Background helper acquisition returns at most one scalar aggregate per
   * admitted message, never tool-detail rows or native input/output bodies. */
  helperAggregates(
    sessionID: string,
    messageIDs: readonly string[],
  ): HelperAggregate[] | undefined {
    const sql = this.native();
    if (!sql) return;
    if (messageIDs.length > SCAN_ROWS) {
      throw new RangeError(
        "Helper aggregate message batch exceeds native row limit",
      );
    }
    if (!messageIDs.length) return [];
    this.observe?.("helpers");
    // Match stock V2's scalar stats projection for split and legacy inline
    // storage. Aggregation stays in SQLite; even a message with many tool calls
    // contributes one count/current row to the worker.
    const rows = sql.prepare(`WITH calls AS MATERIALIZED (
      SELECT message_id,ordinal,0 AS source,
        json_extract(data,'$.name') AS name,
        json_extract(data,'$.state.status') AS status,
        coalesce(json_extract(data,'$.state.metadata.title'),json_extract(data,'$.state.metadata.description')) AS title,
        json_extract(data,'$.time.created') AS created
      FROM session_part WHERE session_id=? AND message_id IN (SELECT value FROM json_each(?)) AND type='tool' AND json_valid(data)
      UNION ALL
      SELECT m.id,p.key,1,
        json_extract(p.value,'$.name'),json_extract(p.value,'$.state.status'),
        coalesce(json_extract(p.value,'$.state.metadata.title'),json_extract(p.value,'$.state.metadata.description')),
        json_extract(p.value,'$.time.created')
      FROM session_message m,json_each(CASE WHEN json_valid(m.data) THEN m.data ELSE '{}' END,'$.content') p
      WHERE m.session_id=? AND m.id IN (SELECT value FROM json_each(?)) AND m.type='assistant' AND json_extract(p.value,'$.type')='tool'
    ), ranked AS (
      SELECT *,row_number() OVER (PARTITION BY message_id ORDER BY CASE WHEN status IN ('running','streaming') THEN 0 ELSE 1 END,created DESC,source DESC,ordinal DESC) AS rank FROM calls
    ) SELECT message_id,count(*) AS tool_count,
      max(CASE WHEN rank=1 AND status IN ('running','streaming') THEN name END) AS current_name,
      max(CASE WHEN rank=1 AND status IN ('running','streaming') THEN title END) AS current_title,
      max(CASE WHEN rank=1 AND status IN ('running','streaming') THEN created END) AS current_created
      FROM ranked GROUP BY message_id ORDER BY message_id`).all(
      ids.decode(sessionID),
      JSON.stringify(messageIDs),
      ids.decode(sessionID),
      JSON.stringify(messageIDs),
    );
    return rows.map((row) => ({
      messageID: String(row.message_id),
      toolCount: Number(row.tool_count),
      ...(typeof row.current_name === "string"
        ? {
          current: {
            name: row.current_name,
            title: text(row.current_title),
            startedAt: millis(row.current_created),
          },
        }
        : {}),
    }));
  }
  /** On-intent tool labels: split rows plus legacy inline content after them. */
  tools(
    sessionID: string,
    messageIDs: string[],
  ): {
    messageID: string;
    tool: UsageTool;
    child?: string;
    status: string;
    created: number;
    completed?: number;
  }[] | undefined {
    const sql = this.native();
    if (!sql) return;
    this.observe?.("tools");
    const extract = (data: string, ordinal: number, messageID: string) => {
      const p = record(JSON.parse(data)),
        state = record(p.state),
        meta = record(state.metadata),
        time = record(p.time);
      if (
        p.type !== "tool" || typeof p.id !== "string" ||
        typeof p.name !== "string"
      ) return [];
      return [{
        messageID,
        tool: {
          id: partID(messageID, "tool", p.id),
          name: p.name,
          summary: text(meta.title) ?? text(meta.description),
        },
        child: text(meta.sessionID),
        status: text(state.status) ?? "running",
        created: millis(time.created),
        completed: time.completed == null ? undefined : millis(time.completed),
        ordinal,
      }];
    };
    const rows = sql.prepare(
      `SELECT message_id,ordinal,json_object('type',type,'id',call_id,'name',json_extract(data,'$.name'),'state',json_object('status',json_extract(data,'$.state.status'),'metadata',json_object('title',json_extract(data,'$.state.metadata.title'),'description',json_extract(data,'$.state.metadata.description'),'sessionID',json_extract(data,'$.state.metadata.sessionID'))),'time',json_object('created',json_extract(data,'$.time.created'),'completed',json_extract(data,'$.time.completed'))) AS scalar FROM session_part WHERE session_id=? AND message_id IN (SELECT value FROM json_each(?)) AND type='tool' AND json_valid(data) ORDER BY message_id,ordinal`,
    ).all(ids.decode(sessionID), JSON.stringify(messageIDs));
    const result = rows.flatMap((r) =>
      extract(String(r.scalar), Number(r.ordinal), String(r.message_id))
    );
    const inline = sql.prepare(
      `SELECT m.id,p.key,json_object('type',json_extract(p.value,'$.type'),'id',json_extract(p.value,'$.id'),'name',json_extract(p.value,'$.name'),'state',json_object('status',json_extract(p.value,'$.state.status'),'metadata',json_object('title',json_extract(p.value,'$.state.metadata.title'),'description',json_extract(p.value,'$.state.metadata.description'),'sessionID',json_extract(p.value,'$.state.metadata.sessionID'))),'time',json_object('created',json_extract(p.value,'$.time.created'),'completed',json_extract(p.value,'$.time.completed'))) AS scalar FROM session_message m,json_each(CASE WHEN json_valid(m.data) THEN m.data ELSE '{}' END,'$.content') p WHERE m.session_id=? AND m.id IN (SELECT value FROM json_each(?)) AND json_extract(p.value,'$.type')='tool' ORDER BY m.seq,p.key`,
    ).all(ids.decode(sessionID), JSON.stringify(messageIDs));
    result.push(
      ...inline.flatMap((r) =>
        extract(String(r.scalar), Number(r.key), String(r.id))
      ),
    );
    return result;
  }
}
