// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import {
  type DigestDelta,
  type SessionMetadata,
  type SessionUsage,
  UsageLedger,
  type UsageMessage,
  type UsageSummary,
} from "@otk/protocol";
import type {
  DigestBudget,
  DigestJob,
  DigestPolicy,
  DigestPublication,
  DigestSink,
} from "@otk/harness";
import type { OpencodeV1Config } from "./config.ts";
import { harnessDb } from "./config.ts";
import { Client } from "./client.ts";
import { Messages } from "./messages.ts";
import { mapIndex } from "./map.ts";
import type { Info, Session } from "./types.ts";
import { type DigestHeader, DigestNativeDb } from "./digest-db.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";

export interface DigestSnapshot {
  metadata: SessionMetadata;
  summary: DigestDelta["summary"];
  deleted: DigestDelta["deleted"];
}
export interface DigestCheckpoint {
  lastMessage: string | null;
  lastHash: string | null;
  generation: number;
  dirty: boolean;
}
/** Injected derived-file port. SQL is used only for this sink's private tables. */
export interface OpencodeV1DigestStorage {
  sql: Pick<DatabaseSync, "prepare">;
  transaction<T>(run: () => T): T;
  read(id: string): DigestSnapshot | undefined;
  turn(id: string, turn: string): UsageSummary | undefined;
  known(): Iterable<DigestSnapshot>;
  write(
    metadata: SessionMetadata,
    delta: DigestDelta,
    checkpoint?: DigestCheckpoint,
  ): void;
  publish(value: DigestPublication): void | Promise<void>;
  diagnostic(id: string | undefined, error: unknown): void;
}
const categories = [
  "cost",
  "input",
  "output",
  "reasoning",
  "cache_read",
  "cache_write",
] as const;
type Category = typeof categories[number];
type Baseline = DigestHeader & { hash: string; scan_generation: number };
interface Replacement {
  previous?: Baseline;
  value?: Baseline;
}
interface Scan {
  after_message: string | null;
  scan_generation: number;
  observed_revision: number;
  complete_revision: number | null;
  dirty: number;
}
function counter(
  value: unknown,
  field: string,
  nullable = true,
): number | null {
  if (value == null && nullable) return null;
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    value > Number.MAX_SAFE_INTEGER ||
    (field !== "cost" && !Number.isSafeInteger(value))
  ) throw new TypeError(`Invalid native digest ${field}`);
  return value;
}
function header(raw: DigestHeader): DigestHeader {
  if (raw.role !== "user" && raw.role !== "assistant") {
    throw new TypeError("Invalid native message role/JSON");
  }
  const result = {
    ...raw,
    time_created: counter(raw.time_created, "time_created", false)!,
    time_completed: counter(raw.time_completed, "time_completed"),
  };
  for (const key of categories) {
    result[key] = raw.role === "assistant" ? counter(raw[key], key) : null;
  }
  for (const key of ["turn_id", "agent", "provider_id", "model_id"] as const) {
    if (result[key] !== null && typeof result[key] !== "string") {
      throw new TypeError(`Invalid native digest ${key}`);
    }
  }
  return result;
}
function fromInfo(info: Info): DigestHeader {
  return header({
    session_id: info.sessionID,
    message_id: info.id,
    role: info.role,
    turn_id: info.role === "assistant" ? info.parentID ?? info.id : null,
    time_created: info.time.created,
    time_completed: info.time.completed ?? null,
    agent: info.agent ?? null,
    provider_id: info.providerID ?? null,
    model_id: info.modelID ?? null,
    cost: info.cost ?? null,
    input: info.tokens?.input ?? null,
    output: info.tokens?.output ?? null,
    reasoning: info.tokens?.reasoning ?? null,
    cache_read: info.tokens?.cache?.read ?? null,
    cache_write: info.tokens?.cache?.write ?? null,
  });
}
async function baseline(
  raw: DigestHeader,
  generation: number,
): Promise<Baseline> {
  const value = header(raw);
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  ].map((n) => n.toString(16).padStart(2, "0")).join("");
  return { ...value, hash, scan_generation: generation };
}
function emptyDelta(revision = 0): DigestDelta {
  return {
    summary: { state: "digesting", revision },
    turns: { upsert: {}, remove: [] },
    deleted: null,
  };
}

/** Provider-owned, restartable scalar sink; never parses Markdown or stores bodies. */
export class OpencodeV1DigestSink implements DigestSink {
  readonly identity = "opencode-v1";
  #client: Client;
  #messages: Messages;
  #native?: DigestNativeDb;
  #closed = false;
  #connection = 0;
  #nativeVerified = false;
  #observation = 0;
  #observed = new Map<string, number>();
  constructor(
    readonly cfg: OpencodeV1Config,
    readonly policy: DigestPolicy,
    readonly storage: OpencodeV1DigestStorage,
    fetcher = fetch,
    readonly openNative: (file: string) => DigestNativeDb = (file) =>
      new DigestNativeDb(file),
  ) {
    this.#client = new Client(cfg.harness, fetcher);
    this.#messages = new Messages(
      this.#client,
      (id) => storage.read(id)?.metadata.directory,
    );
    this.#open();
  }
  #open(): void {
    this.#nativeVerified = false;
    try {
      this.#native = this.openNative(harnessDb(this.cfg));
    } catch (error) {
      this.storage.diagnostic(undefined, error);
    }
  }
  connection(value: number): void {
    if (value < this.#connection) return;
    if (value !== this.#connection) {
      this.#nativeVerified = false;
      this.#observed.clear();
      this.#observation = 0;
      this.storage.sql.prepare(
        "DELETE FROM opcv1_delete_intents WHERE connection_generation<>?",
      ).run(value);
    }
    this.#connection = value;
  }
  async #apiCatalog(signal: AbortSignal): Promise<SessionMetadata[]> {
    const result: SessionMetadata[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const response = await this.#client.request("/experimental/session", {
        query: { limit: 200, cursor },
        signal,
      });
      const rows: Session[] = await response.json();
      result.push(...rows.map((row) => mapIndex(row)));
      cursor = response.headers.get("x-next-cursor") ?? undefined;
      if (cursor && (!rows.length || cursors.has(cursor))) {
        throw new Error("Native catalog cursor did not advance");
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return result;
  }
  async catalog(
    signal: AbortSignal,
    reconcile = true,
  ): Promise<
    { entries: SessionMetadata[]; authoritative: boolean; hints?: string[] }
  > {
    if (this.#closed) throw new Error("Digest sink is closed");
    const health = await this.#client.json<{ healthy: boolean }>(
      "/global/health",
      { signal },
    );
    if (!health.healthy) throw new Error("Native provider is unavailable");
    const admitted = this.#observation;
    let entries: SessionMetadata[] | undefined;
    const empty = new Set<string>();
    if (this.#native && this.#native.fileIdentity() !== this.#native.identity) {
      this.#native.close();
      this.#native = undefined;
      this.#open();
    }
    if (this.#native) {
      try {
        const db = this.#native;
        const rows: SessionMetadata[] = [];
        let after = "";
        while (true) {
          signal.throwIfAborted();
          const page = db.catalog(after, this.policy.batch);
          if (!page.length) break;
          rows.push(...page);
          for (const id of db.emptySessions(page.map((entry) => entry.id))) {
            empty.add(id);
          }
          after = ids.decode(page.at(-1)!.id);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        // Health plus an API identity sample binds this configured file to the service.
        const response = await this.#client.request("/experimental/session", {
          query: { limit: 1 },
          signal,
        });
        const sample: Session[] = await response.json();
        const proof = db.lookup(sample.map((raw) => ids.encode(raw.id)));
        const sampleMatches = sample.length
          ? sample.every((raw) =>
            proof.some((row) =>
              row.id === ids.encode(raw.id) && row.directory === raw.directory
            )
          )
          : db.catalog("", 1).length === 0;
        const conflicting = sample.some((raw) =>
          proof.some((row) =>
            row.id === ids.encode(raw.id) && row.directory !== raw.directory
          )
        );
        if (db.fileIdentity() !== db.identity) {
          empty.clear();
          db.close();
          this.#native = undefined;
          this.#nativeVerified = false;
        } else if (sampleMatches) {
          this.#nativeVerified = true;
          const current = new Map(rows.map((row) => [row.id, row]));
          for (const row of proof) current.set(row.id, row);
          // An empty API and native point proof supersede the older enumeration.
          entries = sample.length ? [...current.values()] : [];
        } else if (conflicting) {
          empty.clear();
          db.close();
          this.#native = undefined;
          this.#nativeVerified = false;
        } else if (this.#nativeVerified) {
          // A disappeared sample is inconclusive, not evidence of a foreign file.
          // The unchanged file and native connection retain their proven binding.
          entries = rows;
        } else {
          empty.clear();
        }
      } catch (error) {
        signal.throwIfAborted();
        this.storage.diagnostic(undefined, error);
        this.#native?.close();
        this.#native = undefined;
        this.#nativeVerified = false;
        empty.clear();
      }
    }
    entries ??= await this.#apiCatalog(signal);
    signal.throwIfAborted();
    const publications: DigestPublication[] = [];
    this.storage.transaction(() => {
      const old = this.storage.sql.prepare(
        "SELECT generation FROM opcv1_inventory WHERE singleton=1",
      ).get();
      const generation = Number(old?.generation ?? 0) + 1;
      this.storage.sql.prepare(
        "INSERT INTO opcv1_inventory VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation,completed_at=excluded.completed_at,database_identity=excluded.database_identity",
      ).run(
        generation,
        Date.now(),
        this.#nativeVerified ? this.#native?.identity ?? null : null,
      );
      const present = this.storage.sql.prepare(
        "INSERT INTO opcv1_presence VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET inventory_generation=excluded.inventory_generation",
      );
      const found = new Set(entries!.map((entry) => entry.id));
      for (const metadata of entries!) {
        present.run(metadata.id, generation);
        const previous = this.storage.read(metadata.id);
        // A pre-observation catalog row cannot revive an accepted retirement.
        if (
          previous?.deleted && (this.#observed.get(metadata.id) ?? 0) > admitted
        ) continue;
        const changed = previous &&
          [
            "title",
            "parentID",
            "directory",
            "projectID",
            "timeUpdated",
            "archived",
          ].some((key) =>
            Reflect.get(metadata, key) !== Reflect.get(previous.metadata, key)
          );
        if (previous && !previous.deleted && !reconcile && !changed) continue;
        const needsScan = reconcile || previous?.deleted ||
          previous?.metadata.timeUpdated !== metadata.timeUpdated;
        const delta = previous
          ? {
            summary: {
              ...previous.summary,
              state: needsScan ? "digesting" as const : previous.summary.state,
              revision: previous.summary.revision + 1,
            },
            turns: { upsert: {}, remove: [] },
            deleted: null,
          }
          : emptyDelta();
        // This is an authoritative empty scan, not an unknown total guessed as
        // zero. Existing nonempty baselines still take the normal sweep path.
        const dirty = this.storage.sql.prepare(
          "SELECT dirty FROM opcv1_scan WHERE session_id=?",
        ).get(metadata.id)?.dirty;
        if (
          empty.has(metadata.id) && !dirty &&
          (!previous || previous.summary.messageCount === 0)
        ) {
          delta.summary = {
            state: "ready",
            revision: delta.summary.revision,
            digestedAt: Date.now(),
            nativeUpdatedAt: metadata.timeUpdated,
            messageCount: 0,
            total: {
              calls: 0,
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              contextPeak: 0,
            },
          };
        }
        this.storage.write(metadata, delta);
        publications.push({
          sessionID: metadata.id,
          revision: delta.summary.revision,
          delta,
        });
      }
      for (const previous of this.storage.known()) {
        if (
          !found.has(previous.metadata.id) && !previous.deleted &&
          (this.#observed.get(previous.metadata.id) ?? 0) <= admitted
        ) {
          const intent = this.storage.sql.prepare(
            "SELECT confirmed FROM opcv1_delete_intents WHERE session_id=? AND connection_generation=?",
          ).get(previous.metadata.id, this.#connection);
          const delta: DigestDelta = {
            summary: {
              ...previous.summary,
              revision: previous.summary.revision + 1,
            },
            turns: { upsert: {}, remove: [] },
            deleted: {
              at: Date.now(),
              how: intent?.confirmed === 1 ? "otk" : "provider",
            },
          };
          this.storage.write(previous.metadata, delta);
          publications.push({
            sessionID: previous.metadata.id,
            revision: delta.summary.revision,
            delta,
          });
        }
      }
    });
    for (const publication of publications) {
      signal.throwIfAborted();
      await this.storage.publish(publication);
    }
    let hints: string[] | undefined;
    try {
      hints = this.#nativeVerified ? this.#native?.hints() : undefined;
    } catch (error) {
      this.storage.diagnostic(undefined, error);
    }
    return {
      entries,
      authoritative: true,
      ...(hints === undefined ? {} : { hints }),
    };
  }
  invalidate(id: string, revision: number): void {
    const native = ids.decode(id);
    this.storage.sql.prepare(
      "INSERT INTO opcv1_scan VALUES(?,?,NULL,0,?,NULL,1) ON CONFLICT(session_id) DO UPDATE SET observed_revision=max(observed_revision,excluded.observed_revision),dirty=1",
    ).run(id, native, revision);
    this.#observed.set(id, ++this.#observation);
  }
  async deleteIntent(
    id: string,
    intent: string,
    phase: "begin" | "confirmed" | "failed",
    connection: number,
  ): Promise<void> {
    ids.decode(id);
    if (connection !== this.#connection) return;
    if (phase === "begin") {
      this.storage.sql.prepare(
        "INSERT INTO opcv1_delete_intents VALUES(?,?,?,?,0) ON CONFLICT(session_id) DO UPDATE SET intent_id=excluded.intent_id,connection_generation=excluded.connection_generation,time=excluded.time,confirmed=0",
      ).run(id, intent, connection, Date.now());
    } else if (phase === "confirmed") {
      const owned = this.storage.sql.prepare(
        "SELECT 1 FROM opcv1_delete_intents WHERE session_id=? AND intent_id=? AND connection_generation=?",
      ).get(id, intent, connection);
      if (!owned) return;
      let delta: DigestDelta | undefined;
      const previous = this.storage.read(id);
      this.storage.transaction(() => {
        this.storage.sql.prepare(
          "UPDATE opcv1_delete_intents SET confirmed=1 WHERE session_id=? AND intent_id=? AND connection_generation=?",
        ).run(id, intent, connection);
        // A native deletion event/inventory may precede the successful response.
        // Only this exact owned intent may upgrade its classification afterward.
        if (previous?.deleted?.how === "provider") {
          delta = {
            summary: {
              ...previous.summary,
              revision: previous.summary.revision + 1,
            },
            turns: { upsert: {}, remove: [] },
            deleted: { ...previous.deleted, how: "otk" },
          };
          this.storage.write(previous.metadata, delta);
        }
      });
      if (delta) {
        await this.storage.publish({
          sessionID: id,
          revision: delta.summary.revision,
          delta,
        });
      }
    } else {this.storage.sql.prepare(
        "DELETE FROM opcv1_delete_intents WHERE session_id=? AND intent_id=? AND connection_generation=?",
      ).run(id, intent, connection);}
  }
  #adjust(id: string, value: Baseline, sign: number): Set<string> {
    const turns = new Set([""]);
    if (value.role === "assistant") {
      turns.add(value.turn_id ?? value.message_id);
    }
    for (const turn of turns) {
      this.storage.sql.prepare(
        `INSERT OR IGNORE INTO opcv1_aggregates VALUES(${
          Array.from({ length: 16 }, () => "?").join(",")
        })`,
      ).run(id, turn, ...Array(14).fill(0));
      const fields: Record<string, number> = {
        message_count: sign,
        call_count: value.role === "assistant" ? sign : 0,
      };
      for (const category of categories) {
        fields[`${category}_sum`] = value.role === "assistant"
          ? sign * (value[category] ?? 0)
          : 0;
        fields[`${category}_unknown`] =
          value.role === "assistant" && value[category] === null ? sign : 0;
      }
      this.storage.sql.prepare(
        `UPDATE opcv1_aggregates SET ${
          Object.keys(fields).map((field) => `${field}=${field}+?`).join(",")
        } WHERE session_id=? AND turn_id=?`,
      ).run(...Object.values(fields), id, turn);
      this.storage.sql.prepare(
        `UPDATE opcv1_aggregates SET ${
          categories.map((key) => `${key}_sum=0,${key}_unknown=0`).join(",")
        } WHERE session_id=? AND turn_id=? AND call_count=0`,
      ).run(id, turn);
      const aggregate = this.storage.sql.prepare(
        "SELECT * FROM opcv1_aggregates WHERE session_id=? AND turn_id=?",
      ).get(id, turn)!;
      for (const [field, number] of Object.entries(aggregate)) {
        if (typeof number === "number") {
          counter(
            number,
            field.endsWith("_sum") && field.startsWith("cost") ? "cost" : field,
            false,
          );
          if (
            field.endsWith("_unknown") && number > Number(aggregate.call_count)
          ) throw new Error("Invalid unknown contribution count");
        }
      }
    }
    return turns;
  }
  #replace(
    id: string,
    value: Baseline | undefined,
    messageID: string,
    turns: Set<string>,
    changes: Replacement[],
  ): void {
    const previous = this.storage.sql.prepare(
      "SELECT * FROM opcv1_messages WHERE session_id=? AND message_id=?",
    ).get(id, messageID) as unknown as Baseline | undefined;
    if (previous && value && previous.hash === value.hash) {
      this.storage.sql.prepare(
        "UPDATE opcv1_messages SET scan_generation=? WHERE session_id=? AND message_id=?",
      ).run(value.scan_generation, id, messageID);
      return;
    }
    changes.push({ previous, value });
    if (previous) {
      for (const key of this.#adjust(id, previous, -1)) turns.add(key);
    }
    this.storage.sql.prepare(
      "DELETE FROM opcv1_messages WHERE session_id=? AND message_id=?",
    ).run(id, messageID);
    if (value) {
      const columns = [
        "session_id",
        "message_id",
        "turn_id",
        "role",
        "hash",
        "scan_generation",
        "time_created",
        "time_completed",
        "agent",
        "provider_id",
        "model_id",
        ...categories,
      ] as const;
      this.storage.sql.prepare(
        `INSERT INTO opcv1_messages(${columns.join(",")}) VALUES(${
          columns.map(() => "?").join(",")
        })`,
      ).run(...columns.map((key) => key === "session_id" ? id : value[key]));
      for (const key of this.#adjust(id, value, 1)) turns.add(key);
    }
  }
  #summary(id: string, turn: string, changes: Replacement[]): UsageSummary {
    const aggregate = this.storage.sql.prepare(
      "SELECT * FROM opcv1_aggregates WHERE session_id=? AND turn_id=?",
    ).get(id, turn);
    const category = (key: Category) =>
      Number(aggregate?.[`${key}_unknown`] ?? 0)
        ? null
        : Number(aggregate?.[`${key}_sum`] ?? 0);
    const previous = turn
      ? this.storage.turn(id, turn)
      : this.storage.read(id)?.summary.total;
    const belongs = (value: Baseline | undefined) =>
      value?.role === "assistant" &&
      (!turn || (value.turn_id ?? value.message_id) === turn);
    const footprint = (value: Baseline) =>
      value.input === null || value.cache_read === null ||
        value.cache_write === null
        ? null
        : value.input + value.cache_read + value.cache_write;
    const calls = Number(aggregate?.call_count ?? 0);
    const unknownPeak = ["input", "cache_read", "cache_write"].some((key) =>
      Number(aggregate?.[`${key}_unknown`] ?? 0) > 0
    );
    let clock = previous?.time, peak = previous?.contextPeak ?? 0;
    const recompute = !previous ||
      changes.some(({ previous: old }) =>
        belongs(old) &&
        (old!.time_created === previous.time?.start ||
          old!.time_completed === previous.time?.end ||
          old!.time_completed === null ||
          footprint(old!) === previous.contextPeak ||
          previous.contextPeak === null && !unknownPeak)
      );
    if (calls === 0) {
      clock = undefined;
      peak = 0;
    } else if (recompute) {
      const time = this.storage.sql.prepare(
        `SELECT min(time_created) AS start,max(time_completed) AS end,sum(time_completed IS NULL) AS unfinished,max(input+cache_read+cache_write) AS peak FROM opcv1_messages WHERE session_id=? AND role='assistant' ${
          turn ? "AND coalesce(turn_id,message_id)=?" : ""
        }`,
      ).get(...(turn ? [id, turn] : [id]))!;
      clock = time.start === null ? undefined : {
        start: Number(time.start),
        ...(Number(time.unfinished) ? {} : { end: Number(time.end) }),
      };
      peak = Number(time.peak ?? 0);
    } else {for (const { value } of changes) {
        if (belongs(value)) {
          const end = clock?.end;
          clock = {
            start: Math.min(
              clock?.start ?? value!.time_created,
              value!.time_created,
            ),
            ...(end !== undefined && value!.time_completed !== null
              ? { end: Math.max(end, value!.time_completed!) }
              : {}),
          };
          peak = Math.max(peak, footprint(value!) ?? 0);
        }
      }}
    return {
      calls,
      cost: category("cost"),
      tokens: {
        input: category("input"),
        output: category("output"),
        reasoning: category("reasoning"),
        cache: { read: category("cache_read"), write: category("cache_write") },
      },
      contextPeak: unknownPeak ? null : peak,
      ...(clock ? { time: clock } : {}),
    };
  }
  async step(
    job: DigestJob,
    budget: DigestBudget,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const id = job.sessionID;
    ids.decode(id);
    signal.throwIfAborted();
    const snapshot = this.storage.read(id);
    if (!snapshot || snapshot.deleted) return;
    let scan = this.storage.sql.prepare(
      "SELECT * FROM opcv1_scan WHERE session_id=?",
    ).get(id) as unknown as Scan | undefined;
    const initialize = !scan;
    scan ??= {
      after_message: null,
      scan_generation: 0,
      observed_revision: job.revision,
      complete_revision: null,
      dirty: 1,
    };
    const targetOffset = job.cursor?.startsWith("target:")
      ? Number(job.cursor.slice(7))
      : 0;
    const native = this.#nativeVerified ? this.#native : undefined;
    const targeted = !!job.messages?.length &&
      (scan.complete_revision !== null || job.cursor?.startsWith("target:")) &&
      !!native;
    const targets = targeted
      ? job.messages!.slice(targetOffset, targetOffset + budget.rows)
      : [];
    const restart = (!job.cursor || job.cursor === "reconcile") && !targeted &&
      (!scan.after_message || scan.complete_revision !== null);
    if (restart) {
      scan = {
        ...scan,
        scan_generation: scan.scan_generation + 1,
        after_message: null,
        complete_revision: null,
        dirty: 0,
      };
    }
    const generation = scan.scan_generation;
    const observed = scan.observed_revision;
    let raw: DigestHeader[];
    let next: string | undefined;
    try {
      if (!targeted && scan.after_message === "~sweep") raw = [];
      else if (targeted) {
        raw = native!.replacements(
          targets.map((messageID) => ({ sessionID: id, messageID })),
        );
        if (targetOffset + targets.length < job.messages!.length) {
          next = `target:${targetOffset + targets.length}`;
        }
      } else if (native) {
        raw = native.headers(
          [id],
          ids.decode(id),
          scan.after_message ?? "",
          budget.rows,
        );
        next = raw.length === budget.rows ? raw.at(-1)!.message_id : undefined;
      } else {
        const page = await this.#messages.page(
          id,
          Math.min(200, budget.rows),
          scan.after_message ?? undefined,
          snapshot.metadata.directory,
          signal,
        );
        raw = page.items.map((message) => fromInfo(message.info));
        next = page.next;
      }
    } catch (error) {
      signal.throwIfAborted();
      if (native) {
        this.storage.diagnostic(id, error);
        native.close();
        this.#native = undefined;
        this.#nativeVerified = false;
        // SQL IDs and opaque API cursors are different domains. Restart the
        // authoritative scan, retaining the last good neutral summary.
        this.storage.transaction(() => {
          if (initialize) this.invalidate(id, job.revision);
          this.storage.sql.prepare(
            "UPDATE opcv1_scan SET after_message=NULL,scan_generation=scan_generation+1,complete_revision=NULL,dirty=1 WHERE session_id=?",
          ).run(id);
        });
        return "retry-api";
      }
      const delta: DigestDelta = {
        summary: {
          ...snapshot.summary,
          state: "unavailable",
          revision: snapshot.summary.revision + 1,
        },
        turns: { upsert: {}, remove: [] },
        deleted: null,
      };
      this.storage.transaction(() =>
        this.storage.write(snapshot.metadata, delta)
      );
      this.storage.diagnostic(id, error);
      await this.storage.publish({
        sessionID: id,
        revision: delta.summary.revision,
        delta,
      });
      return;
    }
    let rows: Baseline[];
    try {
      rows = await Promise.all(raw.map((row) => baseline(row, generation)));
    } catch (error) {
      const delta: DigestDelta = {
        summary: {
          ...snapshot.summary,
          state: "unavailable",
          revision: snapshot.summary.revision + 1,
        },
        turns: { upsert: {}, remove: [] },
        deleted: null,
      };
      this.storage.transaction(() =>
        this.storage.write(snapshot.metadata, delta)
      );
      this.storage.diagnostic(id, error);
      await this.storage.publish({
        sessionID: id,
        revision: delta.summary.revision,
        delta,
      });
      return;
    }
    signal.throwIfAborted();
    let delta!: DigestDelta;
    this.storage.transaction(() => {
      // Scan admission and its first baseline/checkpoint share the commit. A
      // native read or hash may yield; preserve any newer invalidation it raced.
      if (initialize) this.invalidate(id, job.revision);
      if (restart) {
        this.storage.sql.prepare(
          "UPDATE opcv1_scan SET scan_generation=?,after_message=NULL,complete_revision=NULL,dirty=CASE WHEN observed_revision>? THEN 1 ELSE 0 END WHERE session_id=?",
        ).run(generation, observed, id);
      } else if (targeted && !job.cursor) {
        this.storage.sql.prepare(
          "UPDATE opcv1_scan SET dirty=CASE WHEN observed_revision>? THEN 1 ELSE 0 END WHERE session_id=?",
        ).run(observed, id);
      }
      const affected = new Set<string>();
      const changes: Replacement[] = [];
      for (const row of rows) {
        this.#replace(id, row, row.message_id, affected, changes);
      }
      if (targeted) {
        for (const messageID of targets) {
          if (!rows.some((row) => row.message_id === messageID)) {
            this.#replace(id, undefined, messageID, affected, changes);
          }
        }
      }
      if (!next && !targeted) {
        const stale = this.storage.sql.prepare(
          "SELECT message_id FROM opcv1_messages WHERE session_id=? AND scan_generation<>? LIMIT ?",
        ).all(id, generation, budget.rows);
        for (const row of stale) {
          this.#replace(
            id,
            undefined,
            String(row.message_id),
            affected,
            changes,
          );
        }
        if (stale.length === budget.rows) next = "sweep";
      }
      const current = this.storage.sql.prepare(
        "SELECT observed_revision,dirty FROM opcv1_scan WHERE session_id=?",
      ).get(id)!;
      // A dirty marker survives every continuation. A raced edit may be behind
      // the cursor; convergence requires another authoritative sweep, not merely
      // adopting its newer clock at the start of the next page.
      const ready = !next && current.dirty === 0 &&
        Number(current.observed_revision) === observed;
      if (!next && !ready) next = "reconcile";
      const revision = snapshot.summary.revision + 1;
      const upsert: Record<string, UsageSummary> = {}, remove: string[] = [];
      for (const turn of affected) {
        if (turn) {
          const summary = this.#summary(id, turn, changes);
          if (summary.calls) upsert[turn] = summary;
          else remove.push(turn);
        }
      }
      const latest = this.storage.sql.prepare(
        "SELECT * FROM opcv1_messages WHERE session_id=? AND role='assistant' ORDER BY time_created DESC,message_id DESC LIMIT 1",
      ).get(id) as unknown as Baseline | undefined;
      const total = this.#summary(id, "", changes);
      const count = this.storage.sql.prepare(
        "SELECT message_count FROM opcv1_aggregates WHERE session_id=? AND turn_id=''",
      ).get(id)?.message_count ?? 0;
      delta = {
        summary: {
          state: ready ? "ready" : "digesting",
          revision,
          messageCount: Number(count),
          total,
          nativeUpdatedAt: snapshot.metadata.timeUpdated,
          ...(ready ? { digestedAt: Date.now() } : {}),
          ...(latest
            ? {
              last: {
                ...(latest.agent === null ? {} : { agent: latest.agent }),
                ...(latest.provider_id && latest.model_id
                  ? {
                    model: {
                      provider: latest.provider_id,
                      model: latest.model_id,
                    },
                  }
                  : {}),
                context: {
                  input: latest.input,
                  output: latest.output,
                  reasoning: latest.reasoning,
                  cache: { read: latest.cache_read, write: latest.cache_write },
                },
              },
            }
            : {}),
        },
        turns: { upsert, remove },
        deleted: null,
      };
      this.storage.sql.prepare(
        "UPDATE opcv1_scan SET after_message=?,complete_revision=?,dirty=? WHERE session_id=?",
      ).run(
        next === "sweep"
          ? "~sweep"
          : next === "reconcile" || targeted
          ? null
          : next ?? null,
        ready ? observed : null,
        ready ? 0 : Number(current.dirty),
        id,
      );
      this.storage.write(snapshot.metadata, delta, {
        lastMessage: rows.at(-1)?.message_id ?? null,
        lastHash: rows.at(-1)?.hash ?? null,
        generation,
        dirty: !ready,
      });
    });
    await this.storage.publish({
      sessionID: id,
      revision: delta.summary.revision,
      delta,
    });
    return next;
  }
  async detail(id: string, signal: AbortSignal): Promise<SessionUsage> {
    ids.decode(id);
    const metadata = this.storage.read(id)?.metadata;
    if (!metadata) throw new Error("Session usage is unavailable");
    const ledger = new UsageLedger(id);
    const consume = (row: DigestHeader): UsageMessage | undefined => {
      row = header(row);
      if (row.role !== "assistant") return;
      if (
        categories.some((key) => row[key] === null) || !row.provider_id ||
        !row.model_id
      ) throw new Error("Detailed usage is unavailable for unreported headers");
      return {
        id: row.message_id,
        turnID: row.turn_id ?? row.message_id,
        model: { provider: row.provider_id, model: row.model_id },
        tokens: {
          input: row.input!,
          output: row.output!,
          reasoning: row.reasoning!,
          cache: { read: row.cache_read!, write: row.cache_write! },
        },
        cost: row.cost!,
        completed: row.time_completed !== null,
        time: {
          start: row.time_created,
          ...(row.time_completed === null ? {} : { end: row.time_completed }),
        },
      };
    };
    if (this.#nativeVerified && this.#native) {
      let after = "";
      while (true) {
        signal.throwIfAborted();
        const rows = this.#native.headers(
          [id],
          ids.decode(id),
          after,
          this.policy.batch,
        );
        if (!rows.length) break;
        for (const row of rows) {
          const usage = consume(row);
          if (usage) ledger.upsert(usage);
        }
        let part = "";
        while (true) {
          const tools = this.#native.tools(
            id,
            rows.map((row) => row.message_id),
            part,
            this.policy.batch,
          );
          if (!tools.length) break;
          for (const tool of tools) {
            ledger.tool(tool.message_id, {
              id: tool.id,
              name: tool.name,
              ...(tool.summary === null ? {} : { summary: tool.summary }),
            });
          }
          part = tools.at(-1)!.id;
          await new Promise((resolve) => setTimeout(resolve, 0));
          signal.throwIfAborted();
        }
        after = rows.at(-1)!.message_id;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } else {for await (
        const message of this.#messages.scan(id, metadata.directory, signal)
      ) {
        const usage = consume(fromInfo(message.info));
        if (usage) ledger.upsert(usage);
        // Only existing tool labels leave the fallback page; bodies are released.
        for (const part of message.parts) {
          if (part.type === "tool" && part.tool) {
            ledger.tool(message.info.id, {
              id: part.id,
              name: part.tool,
              ...(part.state?.title ? { summary: part.state.title } : {}),
            });
          }
        }
      }}
    return ledger.snapshot();
  }
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#native?.close();
      this.#native = undefined;
    }
  }
}
