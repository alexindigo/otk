// SPDX-License-Identifier: LGPL-3.0-only
import type { DatabaseSync } from "node:sqlite";
import {
  type DigestDelta,
  type HelperSummary,
  OperationFailure,
  type SessionMetadata,
  type TurnUsageSnapshot,
  UsageLedger,
  type UsageSummary,
} from "@otk/protocol";
import {
  type DigestBudget,
  type DigestExecution,
  type DigestJob,
  type DigestPolicy,
  type DigestPublication,
  type DigestSink,
  identityReadCodec,
  type ProjectSeed,
  type ProviderReaders,
  type SessionIdentity,
  sessionListReadCodec,
  type TranscriptMetadata,
} from "@otk/harness";
import {
  type V2Client,
  V2Client as Client,
  V2MissingSession,
} from "./client.ts";
import { discoverV2 } from "./discovery.ts";
import { V2NativeDb } from "./native-db.ts";
import { V2SessionLists } from "./session-lists.ts";
import { metadata } from "./metadata.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { upgradeReadCodec } from "./upgrade-read.ts";
import { scalarSessionReadCodec } from "./index-reads.ts";
import { Messages, type NativeSession, SCAN_ROWS } from "./messages.ts";
import { millis, partID, record, reported, text, tokens } from "./map.ts";
import {
  type ScalarMessage,
  scalarMessage,
  transcriptReadCodecs,
  TranscriptReads,
} from "./transcript-reads.ts";
import {
  type NativeProjectTopology,
  V2ProjectTopology,
} from "./project-topology.ts";

export interface V2NativeConfig {
  serviceFile: string;
  db: string;
  requestms: number;
}
export interface V2DigestStorage {
  sql: Pick<DatabaseSync, "prepare">;
  transaction<T>(run: () => T): T;
  read(
    id: string,
  ): {
    metadata: SessionMetadata;
    summary: DigestDelta["summary"];
    deleted: DigestDelta["deleted"];
    helper?: HelperSummary;
  } | undefined;
  turn(id: string, turn: string): UsageSummary | undefined;
  known(): Iterable<
    {
      metadata: SessionMetadata;
      summary: DigestDelta["summary"];
      deleted: DigestDelta["deleted"];
    }
  >;
  write(metadata: SessionMetadata, delta: DigestDelta): void;
  publish(value: DigestPublication): void | Promise<void>;
  diagnostic(id: string | undefined, error: unknown): void;
}
export interface V2DigestReadiness {
  demanded?(metadata: SessionMetadata): void;
  work?(ms: number): void;
  wait?<T>(value: Promise<T>, join?: boolean): Promise<T>;
  ioWait?<T>(value: Promise<T>, join?: boolean): Promise<T>;
  admission?(signal: AbortSignal): Promise<() => void>;
  listed?(rows: readonly SessionMetadata[], signal: AbortSignal): Promise<void>;
  prefetchList?(
    input: import("@otk/protocol").SessionListInput,
    read: (signal: AbortSignal) => Promise<void>,
  ): void;
}
export const opencodeV2ReadCodecs: import("@otk/harness").ProviderReadCodecs = {
  ...transcriptReadCodecs,
  "opcv2.sessions": scalarSessionReadCodec,
  "opcv2.upgrade": upgradeReadCodec,
  "identity.batch": identityReadCodec,
  "sessions.list": sessionListReadCodec,
};

/** The same worker/scheduler/native permission as V1; no second SQL owner. */
export class OpencodeV2DigestSink implements DigestSink {
  readonly identity = "opencode-v2-server";
  readonly readers: ProviderReaders;
  readonly #transcripts: OpencodeV2TranscriptDigestSink;
  readonly #lists = new V2SessionLists();
  #native?: V2NativeDb;
  #client?: V2Client;
  #connection = 0;
  #closed = false;
  #lifetime = new AbortController();
  #source?: string;
  #projectDirectories = new Set<string>();
  #wait: <T>(value: Promise<T>) => Promise<T>;
  constructor(
    readonly config: V2NativeConfig,
    readonly policy: DigestPolicy,
    readonly storage: V2DigestStorage,
    readonly readiness: V2DigestReadiness = {},
    readonly observe?: (
      operation: string,
      sample?: { limit: number; rows: number },
    ) => void,
  ) {
    this.#wait = readiness.wait ?? ((p) => p);
    this.#transcripts = new OpencodeV2TranscriptDigestSink(
      policy,
      storage,
      readiness,
      {
        prepare: (signal) =>
          this.#prepare(signal).then(({ client }) => ({
            client,
            native: this.#native,
          })),
        native: () => this.#native,
        check: (signal) => this.#check(signal),
      },
    );
    this.readers = {
      ...this.#transcripts.readers,
      "opcv2.sessions": async (input, signal) => {
        const connection = this.#connection,
          { client } = await this.#prepare(signal);
        const result: import("./metadata.ts").SessionFacts[] = [],
          keys = [...new Set(input.ids)];
        keys.forEach(ids.decode);
        for (let at = 0; at < keys.length; at += policy.batch) {
          this.#check(signal, connection);
          const batch = keys.slice(at, at + policy.batch);
          if (this.#native) result.push(...this.#native.facts(batch));
          else {for (const key of batch) {
              try {
                const {
                  id,
                  location,
                  projectID,
                  title,
                  parentID,
                  time,
                  outcome,
                } = await client.read(
                  (api) =>
                    api.session.get({ sessionID: ids.decode(key) }, {
                      signal,
                    }),
                  signal,
                );
                result.push({
                  id,
                  location,
                  projectID,
                  title,
                  parentID,
                  time,
                  outcome,
                });
              } catch (error) {
                if (!(error instanceof V2MissingSession)) throw error;
              }
            }}
          await this.#yield(signal);
        }
        return result;
      },
      "opcv2.upgrade": async (input, signal) => {
        await this.#prepare(signal);
        if (!this.#native) {
          throw new OperationFailure(
            "unavailable",
            "native.unavailable",
            new Error("V2 upgrade source identity is unavailable"),
          );
        }
        const result: string[] = [];
        const keys = [...new Set(input.ids)];
        for (let at = 0; at < keys.length; at += policy.batch) {
          this.#check(signal);
          result.push(
            ...this.#native.upgrade(keys.slice(at, at + policy.batch)),
          );
          await this.#yield(signal);
        }
        return result;
      },
      "identity.batch": (input, signal) => this.identities(input.ids, signal),
      "sessions.list": async (input, signal) => {
        const result = await this.#list(input, signal);
        for (const row of result.items) await this.#remember(row, signal);
        await readiness.listed?.(result.items, signal);
        if (result.older) {
          const next = { ...input, before: result.older };
          readiness.prefetchList?.(next, async (signal) => {
            await this.#list(next, signal);
          });
        }
        return result;
      },
    };
  }
  connection(value: number): void {
    if (value === this.#connection) return;
    this.#connection = value;
    this.#transcripts.connection(value);
    this.#lists.reset();
    this.#source = undefined;
    this.#native?.close();
    this.#native = undefined;
  }
  #check(signal: AbortSignal, connection = this.#connection): void {
    signal.throwIfAborted();
    this.#lifetime.signal.throwIfAborted();
    if (this.#closed || connection !== this.#connection) {
      throw new Error("V2 native generation changed");
    }
    let fileIdentity: string | undefined;
    try {
      fileIdentity = this.#native?.fileIdentity();
    } catch { /* Removal also retires the old inode owner. */ }
    if (this.#native && fileIdentity !== this.#native.identity) {
      this.#native.close();
      this.#native = undefined;
      this.#lists.reset();
      this.#source = undefined;
      throw new Error("V2 native database was replaced");
    }
  }
  async #io<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const wait = this.readiness.ioWait ?? this.#wait;
    const release = await wait(
      this.readiness.admission?.(signal) ?? Promise.resolve(() => {}),
    );
    try {
      return await wait(run());
    } finally {
      release();
    }
  }
  async #prepare(
    signal: AbortSignal,
  ): Promise<
    {
      client: V2Client;
      projects: Awaited<
        ReturnType<import("./client.ts").OpenCodeClient["project"]["list"]>
      >;
    }
  > {
    const connection = this.#connection;
    this.#check(signal);
    const service = await this.#io(
      signal,
      () => discoverV2(this.config.serviceFile, signal),
    );
    const source = `${service.endpoint.url}:${service.pid}:${service.version}`;
    if (source !== this.#source) {
      this.#native?.close();
      this.#native = undefined;
      this.#lists.reset();
      this.#source = source;
    }
    const client = this.#client = new Client(
      service,
      this.config.requestms,
      this.#lifetime.signal,
      fetch,
      this.readiness.admission,
      this.readiness.ioWait ?? this.#wait,
    );
    const projects = await client.read(
      (api) => api.project.list({ archived: true }, { signal }),
      signal,
    );
    this.#check(signal, connection);
    if (!this.#native) {
      try {
        this.#native = new V2NativeDb(this.config.db, this.observe);
      } catch (error) {
        this.storage.diagnostic(undefined, error);
      }
    }
    if (this.#native && !this.#native.prove(projects)) {
      this.storage.diagnostic(
        undefined,
        new Error("V2 native project identity proof failed; using API"),
      );
      this.#native.close();
      this.#native = undefined;
    }
    return { client, projects };
  }
  async #yield(signal: AbortSignal): Promise<void> {
    await this.#wait(new Promise<void>((resolve) => setTimeout(resolve, 0)));
    this.#check(signal);
  }
  async #list(
    input: import("@otk/protocol").SessionListInput,
    signal: AbortSignal,
  ) {
    const connection = this.#connection,
      { client } = await this.#prepare(signal);
    const result = await this.#lists.read(input, client, this.#native, signal);
    this.#check(signal, connection);
    return result;
  }
  async identities(
    wanted: readonly string[],
    signal: AbortSignal,
  ): Promise<SessionIdentity[]> {
    const connection = this.#connection,
      { client } = await this.#prepare(signal);
    const result: SessionIdentity[] = [], keys = [...new Set(wanted)];
    keys.forEach(ids.decode);
    for (let at = 0; at < keys.length; at += this.policy.batch) {
      this.#check(signal, connection);
      const batch = keys.slice(at, at + this.policy.batch);
      if (this.#native) result.push(...this.#native.identities(batch));
      else {for (const key of batch) {
          try {
            const row = await client.read(
              (api) =>
                api.session.get({ sessionID: ids.decode(key) }, { signal }),
              signal,
            );
            result.push({
              id: key,
              directory: row.location.directory,
              ...(row.parentID ? { parentID: ids.encode(row.parentID) } : {}),
            });
          } catch (error) {
            if (!(error instanceof V2MissingSession)) throw error;
          }
        }}
      await this.#yield(signal);
    }
    this.#check(signal, connection);
    return result;
  }
  async #remember(row: SessionMetadata, signal: AbortSignal): Promise<void> {
    this.#check(signal);
    const previous = this.storage.read(row.id);
    const delta: DigestDelta = {
      summary: previous?.summary ?? { state: "digesting", revision: 0 },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    };
    this.storage.write(row, delta);
    if (!previous) {
      await this.storage.publish({
        sessionID: row.id,
        revision: delta.summary.revision,
        metadata: row,
        delta,
      });
    }
  }
  async hydrate(
    wanted: readonly string[],
    signal: AbortSignal,
  ): Promise<SessionMetadata[]> {
    const connection = this.#connection,
      { client } = await this.#prepare(signal);
    const pending = [...new Set(wanted)],
      seen = new Set<string>(),
      result: SessionMetadata[] = [];
    pending.forEach(ids.decode);
    while (pending.length) {
      this.#check(signal, connection);
      const keys = pending.splice(0, this.policy.batch).filter((id) =>
        !seen.has(id)
      );
      keys.forEach((id) => seen.add(id));
      const rows = this.#native ? this.#native.lookup(keys) : [];
      if (!this.#native) {
        for (const key of keys) {
          try {
            rows.push(metadata(
              await client.read(
                (api) =>
                  api.session.get({ sessionID: ids.decode(key) }, { signal }),
                signal,
              ),
            ));
          } catch (error) {
            if (!(error instanceof V2MissingSession)) {
              throw error;
            }
          }
        }
      }
      this.#check(signal, connection);
      for (const row of rows) {
        await this.#remember(row, signal);
        result.push(row);
        if (row.parentID && !seen.has(row.parentID)) pending.push(row.parentID);
      }
      await this.#yield(signal);
    }
    return result;
  }
  async projects(
    signal: AbortSignal,
    publish?: (rows: ProjectSeed[]) => Promise<void>,
    directory?: string,
  ): Promise<{ projects: ProjectSeed[]; hints?: string[] }> {
    const connection = this.#connection,
      { client, projects: reported } = await this.#prepare(signal);
    const inventory: NativeProjectTopology[] = [];
    for (const project of reported) {
      this.#check(signal, connection);
      try {
        const worktrees = await client.read(
          (api) => api.worktree.list({ projectID: project.id }, { signal }),
          signal,
        );
        inventory.push({ ...project, worktrees });
      } catch (error) {
        this.#check(signal, connection);
        this.storage.diagnostic(undefined, error);
        inventory.push({ ...project });
      }
      await this.#yield(signal);
    }
    const topology = new V2ProjectTopology(inventory);
    const roots = new Set(topology.roots());
    const projects: ProjectSeed[] = [];
    const append = async (rows: ProjectSeed[]) => {
      this.#check(signal, connection);
      for (const row of rows) this.#projectDirectories.add(row.directory);
      projects.push(...rows);
      await publish?.(rows);
      await this.#yield(signal);
    };
    if (!this.#native) {
      // Unknown population is not an empty catalog and must not trigger enumeration.
      const rows = (directory === undefined
        ? [...new Set([...roots, ...this.#projectDirectories])]
        : [directory]).map((directory) => ({
          directory,
          // Without SQL, only exact inventory roots establish native ownership.
          // A retained nested scope is unknown, not a retired relationship.
          topology: roots.has(directory) && inventory.every((row) =>
              row.worktrees !== undefined
            )
            ? topology.root(directory)
            : undefined,
          sessionCount: null,
          lastActivity: null,
          authority: "unknown" as const,
        }));
      for (let at = 0; at < rows.length; at += this.policy.batch) {
        await append(rows.slice(at, at + this.policy.batch));
      }
      return { projects };
    }
    let after = "";
    for (;;) {
      this.#check(signal, connection);
      const rows = this.#native.projects(after, this.policy.batch, directory)
        .map(
          ({ projectID, ...row }) => ({
            ...row,
            topology: topology.resolve(row.directory, projectID),
          }),
        );
      if (!rows.length) break;
      await append(rows);
      after = rows.at(-1)!.directory;
    }
    const populated = new Set(projects.map((row) => row.directory));
    const empty =
      (directory === undefined
        ? [...new Set([...roots, ...this.#projectDirectories])]
        : [directory]).filter((root) => !populated.has(root)).map((
          directory,
        ): ProjectSeed => ({
          directory,
          topology: inventory.every((row) => row.worktrees !== undefined)
            ? topology.root(directory)
            : undefined,
          hasSessions: false,
          sessionCount: 0,
          lastActivity: null,
          authority: "current",
        }));
    for (let at = 0; at < empty.length; at += this.policy.batch) {
      await append(empty.slice(at, at + this.policy.batch));
    }
    return { projects };
  }
  catalog(
    signal: AbortSignal,
  ): Promise<{ entries: SessionMetadata[]; authoritative: boolean }> {
    this.#check(signal);
    return Promise.resolve({ entries: [], authoritative: false });
  }
  discover(
    signal: AbortSignal,
  ): Promise<{ entries: SessionMetadata[]; complete: boolean }> {
    this.#check(signal);
    return Promise.resolve({ entries: [], complete: true });
  }
  discoveryProject(_directory: string, _active: boolean): void {}
  pending(id: string): boolean {
    return this.#transcripts.pending(id);
  }
  invalidate(id: string, revision: number): void {
    this.#lists.invalidate();
    this.#transcripts.invalidate(id, revision);
  }
  invalidateHelper(id: string): void {
    this.#transcripts.invalidateHelper(id);
  }
  requestHelper(id: string, changed: boolean): boolean {
    return this.#transcripts.requestHelper(id, changed);
  }
  step(
    job: DigestJob,
    budget: DigestBudget,
    signal: AbortSignal,
    execution: DigestExecution,
  ): Promise<string | undefined> {
    return this.#transcripts.step(job, budget, signal, execution);
  }
  detail(
    id: string,
    turnID: string,
    signal: AbortSignal,
  ): Promise<TurnUsageSnapshot> {
    return this.#transcripts.detail(id, turnID, signal);
  }
  transcriptMetadata(
    id: string,
    turns: readonly string[],
    signal: AbortSignal,
    cutoff?: string,
    boundary?: import("@otk/harness").DigestBoundary,
  ): Promise<TranscriptMetadata> {
    return this.#transcripts.transcriptMetadata(
      id,
      turns,
      signal,
      cutoff,
      boundary,
    );
  }
  deleted(
    connection: number,
    id: string,
    revision: number,
    metadata?: SessionMetadata,
  ): Promise<void> {
    return this.#transcripts.deleted(connection, id, revision, metadata);
  }
  deleteIntent(
    id: string,
    intent: string,
    phase: "begin" | "confirmed" | "failed",
    connection: number,
  ): Promise<void> {
    return this.#transcripts.deleteIntent(id, intent, phase, connection);
  }
  close(): void {
    this.#closed = true;
    this.#lifetime.abort();
    this.#transcripts.close();
    this.#native?.close();
    this.#native = undefined;
  }
}
interface V2DigestSource {
  prepare(
    signal: AbortSignal,
  ): Promise<{ client: V2Client; native?: V2NativeDb }>;
  native(): V2NativeDb | undefined;
  check(signal: AbortSignal): void;
}
interface Scan {
  generation: number;
  revision: number;
  complete: number;
  exhausted: number;
  source: string | null;
  after_seq: number | null;
  api_cursor: string | null;
}
/** Selected by the application's one worker: no serving-isolate SQLite owner. */
export class OpencodeV2TranscriptDigestSink implements DigestSink {
  readonly identity = "opencode-v2-server";
  readonly readers: ProviderReaders;
  readonly messages: Messages;
  readonly transcript: TranscriptReads;
  #provenNative?: V2NativeDb;
  get #native(): DatabaseSync | undefined {
    const native = this.source.native();
    return native === this.#provenNative ? native?.db : undefined;
  }
  #client?: V2Client;
  #closed = false;
  #connection = 0;
  #source = "api";
  #helperDirty = new Set<string>();
  #helperValidated = new Set<string>();
  #sourceError?: string;
  #helpers = new Map<
    string,
    {
      generation: number;
      before?: number;
      cursor?: string;
      source: string;
      exhausted?: boolean;
      keys?: string[];
      offset?: number;
    }
  >();
  constructor(
    readonly policy: DigestPolicy,
    readonly storage: V2DigestStorage,
    readonly readiness: V2DigestReadiness,
    readonly source: V2DigestSource,
  ) {
    this.messages = new Messages(() => {
      if (!this.#client) throw new Error("V2 worker is not connected");
      return this.#client;
    });
    this.transcript = new TranscriptReads(
      this.messages,
      () => this.#native,
      (signal) => this.#yield(signal),
      () => this.#source,
    );
    this.readers = {
      "opcv2.transcript": async (input, signal) => {
        await this.#ensure(input.sessionID, signal);
        return await this.transcript.facts(input, signal);
      },
      "opcv2.message.prefetch": async (input, signal) => {
        await this.#ensure(input.sessionID, signal);
        const value = await this.transcript.prefetch(input, signal);
        const oldest = value.page.items.reduce<
          import("./messages.ts").NativeMessage | undefined
        >(
          (old, row) =>
            !old ||
              (value.facts.contexts[row.id]?.order ?? Infinity) <
                (value.facts.contexts[old.id]?.order ?? Infinity)
              ? row
              : old,
          undefined,
        );
        if (oldest) {
          value.facts.metadata = await this.transcriptMetadata(
            input.sessionID,
            Object.keys(value.facts.contexts),
            signal,
            input.cutoff,
            { messageID: oldest.id, created: millis(oldest.time.created) },
          );
        }
        return value;
      },
    };
  }
  async #yield(signal: AbortSignal): Promise<void> {
    this.source.check(signal);
    await (this.readiness.wait?.(new Promise<void>((r) => setTimeout(r, 0))) ??
      new Promise<void>((r) => setTimeout(r, 0)));
    this.source.check(signal);
  }
  async #ensure(id: string, signal: AbortSignal): Promise<NativeSession> {
    if (this.#closed) throw new Error("V2 transcript digest is stopped");
    const connection = this.#connection;
    const { client, native } = await this.source.prepare(signal),
      raw = await client.read(
        (api) => api.session.get({ sessionID: ids.decode(id) }, { signal }),
        signal,
      );
    this.source.check(signal);
    if (connection !== this.#connection) {
      throw new Error("V2 transcript source changed");
    }
    this.#client = client;
    this.#source = `api:${client.service.pid}:${this.#connection}`;
    this.#provenNative = undefined;
    if (!native || native !== this.source.native()) return raw;
    try {
      const db = native.db;
      for (
        const [table, required] of [["session_v2", [
          "id",
          "project_id",
          "directory",
        ]], ["session_message", [
          "id",
          "session_id",
          "type",
          "seq",
          "time_created",
          "data",
        ]], ["session_part", [
          "message_id",
          "session_id",
          "ordinal",
          "type",
          "call_id",
          "data",
        ]]] as const
      ) {
        const columns = new Set(
          db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name),
        );
        if (required.some((c) => !columns.has(c))) {
          throw new Error("Incompatible V2 native schema");
        }
      }
      const row = db.prepare(
        "SELECT directory,project_id FROM session_v2 WHERE id=?",
      ).get(raw.id);
      if (
        row &&
        (row.directory !== raw.location.directory ||
          row.project_id !== raw.projectID)
      ) throw new Error("V2 database session identity differs from service");
      if (!row) {
        throw new Error("V2 database has not observed the requested session");
      }
      this.#provenNative = native;
      this.#source = `sql:${native.identity}:${client.service.pid}`;
      this.#sourceError = undefined;
    } catch (error) {
      signal.throwIfAborted();
      this.#provenNative = undefined;
      const message = String(error);
      if (message !== this.#sourceError) {
        this.#sourceError = message;
        this.storage.diagnostic(id, error);
      }
    }
    return raw;
  }
  connection(value: number): void {
    if (value === this.#connection) return;
    this.#connection = value;
    this.#client = undefined;
    this.#provenNative = undefined;
    this.#helpers.clear();
    this.#helperValidated.clear();
    this.#sourceError = undefined;
  }
  async hydrate(
    keys: readonly string[],
    signal: AbortSignal,
  ): Promise<SessionMetadata[]> {
    const rows: SessionMetadata[] = [];
    for (const id of new Set(keys)) {
      const raw = await this.#ensure(id, signal), entry = metadata(raw);
      const previous = this.storage.read(id);
      if (!previous) {
        this.storage.transaction(() =>
          this.storage.write(entry, {
            summary: { state: "digesting", revision: 0 },
            turns: { upsert: {}, remove: [] },
            deleted: null,
          })
        );
      }
      rows.push(entry);
      await this.#yield(signal);
    }
    return rows;
  }
  // Transcript work never enumerates the session population. V1 contributes the
  // keyed index/list provider; these compatibility ports leave it unacquired.
  catalog(
    _signal: AbortSignal,
  ): Promise<{ entries: SessionMetadata[]; authoritative: boolean }> {
    return Promise.resolve({ entries: [], authoritative: false });
  }
  projects(
    _signal: AbortSignal,
    _publish?: (
      rows: import("@otk/harness").ProjectSeed[],
    ) => Promise<void>,
    _directory?: string,
  ): Promise<{ projects: import("@otk/harness").ProjectSeed[] }> {
    return Promise.resolve({ projects: [] });
  }
  discover(
    _signal: AbortSignal,
  ): Promise<{ entries: SessionMetadata[]; complete: boolean }> {
    return Promise.resolve({ entries: [], complete: true });
  }
  discoveryProject(_directory: string, _active: boolean): void {}
  pending(id: string): boolean {
    return !this.#scan(id)?.complete;
  }
  #scan(id: string): Scan | undefined {
    return this.storage.sql.prepare(
      "SELECT generation,revision,complete,exhausted,source,after_seq,api_cursor FROM opcv2_transcript_scan WHERE session_id=?",
    ).get(id) as unknown as Scan | undefined;
  }
  invalidate(id: string, revision = 0): void {
    const next = Math.max(revision, (this.#scan(id)?.revision ?? 0) + 1);
    this.storage.sql.prepare(
      "INSERT INTO opcv2_transcript_scan(session_id,revision) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,complete=0,exhausted=0,source=NULL,after_seq=NULL,api_cursor=NULL",
    ).run(id, next);
  }
  invalidateHelper(id: string): void {
    this.#helperDirty.add(id);
    this.#helpers.delete(id);
  }
  requestHelper(id: string, changed: boolean): boolean {
    if (changed) this.invalidateHelper(id);
    return this.#helperDirty.has(id) ||
      !this.#helperValidated.has(id) ||
      this.storage.read(id)?.helper?.state !== "ready";
  }
  async #commit(entry: SessionMetadata, delta: DigestDelta): Promise<void> {
    this.storage.transaction(() => this.storage.write(entry, delta));
    await this.storage.publish({
      sessionID: entry.id,
      revision: delta.summary.revision,
      delta,
      metadata: entry,
    });
  }
  async step(
    job: DigestJob,
    budget: DigestBudget,
    signal: AbortSignal,
    _execution?: DigestExecution,
  ): Promise<string | undefined> {
    if (job.projection === "helper") {
      return await this.#helperStep(job, budget, signal);
    }
    const raw = await this.#ensure(job.sessionID, signal),
      entry = metadata(raw),
      source = this.#source;
    let scan = this.#scan(job.sessionID);
    if (!scan || scan.source !== source) {
      const generation = (scan?.generation ?? 0) + 1;
      this.storage.sql.prepare(
        "INSERT INTO opcv2_transcript_scan(session_id,generation,source,revision) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation,source=excluded.source,after_seq=NULL,api_cursor=NULL,complete=0,exhausted=0",
      ).run(
        job.sessionID,
        generation,
        source,
        scan?.revision ?? 0,
      );
      scan = this.#scan(job.sessionID)!;
    }
    const admitted = { ...scan };
    let rows = scan.exhausted ? [] : this.transcript.sqlHeaders(
        job.sessionID,
        scan.after_seq ?? undefined,
        Math.min(budget.rows, SCAN_ROWS),
      ),
      next: string | undefined;
    if (!rows) {
      const page = await this.messages.page(
        job.sessionID,
        Math.min(budget.rows, SCAN_ROWS),
        scan.api_cursor ?? undefined,
        signal,
      );
      next = page.next;
      let order = scan.after_seq ?? 0;
      rows = [...page.items].reverse().map((m) => scalarMessage(m, --order));
    }
    signal.throwIfAborted();
    if (
      source !== this.#source ||
      this.#scan(job.sessionID)?.revision !== admitted.revision
    ) return "reconcile";
    let complete = !!scan.exhausted ||
      (this.#native ? rows.length < Math.min(budget.rows, SCAN_ROWS) : !next);
    const turns = new Set<string>();
    this.storage.transaction(() => {
      const put = this.storage.sql.prepare(
        "INSERT INTO opcv2_transcript_header(session_id,message_id,seq,type,turn_id,scalar,generation) VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET seq=excluded.seq,type=excluded.type,turn_id=excluded.turn_id,scalar=excluded.scalar,generation=excluded.generation",
      );
      for (const row of rows!) {
        if (row.usage && this.#native) turns.add(row.usage.turnID);
        put.run(
          job.sessionID,
          row.id,
          row.seq,
          row.type,
          this.#native ? row.usage?.turnID ?? null : null,
          JSON.stringify(row),
          admitted.generation,
        );
      }
      if (!this.#native) {
        for (const row of rows!) {
          if (row.type !== "user") continue;
          // Descending acquisition discovers each real prompt after its calls.
          // Rebind only those unanchored calls, never an idle execution group.
          this.storage.sql.prepare(
            "UPDATE opcv2_transcript_header SET turn_id=?,scalar=json_set(scalar,'$.usage.turnID',?) WHERE session_id=? AND type='assistant' AND turn_id IS NULL AND seq>?",
          ).run(row.id, row.id, job.sessionID, row.seq);
          turns.add(row.id);
        }
        if (complete) {
          this.storage.sql.prepare(
            "UPDATE opcv2_transcript_header SET turn_id=message_id,scalar=json_set(scalar,'$.usage.turnID',message_id) WHERE session_id=? AND type='assistant' AND turn_id IS NULL",
          ).run(job.sessionID);
        }
      }
      this.storage.sql.prepare(
        "UPDATE opcv2_transcript_scan SET after_seq=?,api_cursor=?,complete=?,exhausted=? WHERE session_id=?",
      ).run(
        rows!.at(-1)?.seq ?? scan!.after_seq,
        next ?? null,
        complete ? 1 : 0,
        complete ? 1 : 0,
        job.sessionID,
      );
      if (complete) {
        const stale = this.storage.sql.prepare(
          "SELECT message_id,turn_id FROM opcv2_transcript_header WHERE session_id=? AND generation<>? LIMIT ?",
        ).all(job.sessionID, admitted.generation, budget.rows);
        for (const old of stale) {
          if (old.turn_id) turns.add(String(old.turn_id));
        }
        this.storage.sql.prepare(
          "DELETE FROM opcv2_transcript_header WHERE session_id=? AND message_id IN (SELECT value FROM json_each(?))",
        ).run(job.sessionID, JSON.stringify(stale.map((r) => r.message_id)));
        complete = stale.length < budget.rows;
        this.storage.sql.prepare(
          "UPDATE opcv2_transcript_scan SET complete=? WHERE session_id=?",
        ).run(complete ? 1 : 0, job.sessionID);
      }
    });
    const previous = this.storage.read(job.sessionID),
      total = this.#summary(job.sessionID);
    const nativeUsage = record(raw),
      nativeTokens = tokens(nativeUsage.tokens),
      nativeCost = reported(nativeUsage.cost);
    const summaries: Record<string, UsageSummary> = {};
    for (const turn of turns) {
      summaries[turn] = this.#summary(job.sessionID, turn);
    }
    const delta: DigestDelta = {
      summary: {
        state: complete ? "ready" : "digesting",
        revision: (previous?.summary.revision ?? 0) + 1,
        digestedAt: Date.now(),
        nativeUpdatedAt: millis(raw.time.updated),
        messageCount: this.storage.sql.prepare(
          "SELECT COUNT(*) AS n FROM opcv2_transcript_header WHERE session_id=?",
        ).get(job.sessionID)!.n as number,
        total: { ...total, cost: nativeCost, tokens: nativeTokens },
      },
      turns: { upsert: summaries, remove: [] },
      deleted: null,
    };
    await this.#commit(entry, delta);
    return complete ? undefined : "continue";
  }
  #summary(id: string, turn?: string): UsageSummary {
    const paths = [
      "tokens.input",
      "tokens.output",
      "tokens.reasoning",
      "tokens.cache.read",
      "tokens.cache.write",
      "cost",
    ];
    const numeric = paths.map((path, i) =>
      `CASE WHEN count(json_extract(scalar,'$.usage.${path}'))=count(*) THEN COALESCE(sum(json_extract(scalar,'$.usage.${path}')),0) END AS v${i}`
    ).join(",");
    const row = this.storage.sql.prepare(
      `SELECT count(*) AS calls,${numeric},min(json_extract(scalar,'$.usage.time.start')) AS start,CASE WHEN sum(json_extract(scalar,'$.usage.completed')=0)>0 THEN NULL ELSE max(json_extract(scalar,'$.usage.time.end')) END AS end,CASE WHEN count(json_extract(scalar,'$.usage.tokens.input')+json_extract(scalar,'$.usage.tokens.cache.read')+json_extract(scalar,'$.usage.tokens.cache.write'))=count(*) THEN COALESCE(max(json_extract(scalar,'$.usage.tokens.input')+json_extract(scalar,'$.usage.tokens.cache.read')+json_extract(scalar,'$.usage.tokens.cache.write')),0) END AS peak FROM opcv2_transcript_header WHERE session_id=? AND type='assistant' ${
        turn === undefined ? "" : "AND turn_id=?"
      }`,
    ).get(...(turn === undefined ? [id] : [id, turn]))!;
    return {
      calls: Number(row.calls),
      cost: row.v5 == null ? null : Number(row.v5),
      tokens: {
        input: row.v0 == null ? null : Number(row.v0),
        output: row.v1 == null ? null : Number(row.v1),
        reasoning: row.v2 == null ? null : Number(row.v2),
        cache: {
          read: row.v3 == null ? null : Number(row.v3),
          write: row.v4 == null ? null : Number(row.v4),
        },
      },
      contextPeak: row.peak == null ? null : Number(row.peak),
      ...(row.start == null ? {} : {
        time: {
          start: Number(row.start),
          ...(row.end == null ? {} : { end: Number(row.end) }),
        },
      }),
    };
  }
  async #stored(
    id: string,
    signal: AbortSignal,
    turn?: string,
  ): Promise<ScalarMessage[]> {
    const values: ScalarMessage[] = [];
    let after = -Number.MAX_SAFE_INTEGER;
    for (;;) {
      signal.throwIfAborted();
      const rows = this.storage.sql.prepare(
        `SELECT seq,scalar FROM opcv2_transcript_header WHERE session_id=? AND seq>? ${
          turn === undefined ? "" : "AND turn_id=?"
        } ORDER BY seq LIMIT ?`,
      ).all(
        ...(turn === undefined
          ? [id, after, this.policy.batch]
          : [id, after, turn, this.policy.batch]),
      );
      for (const r of rows) values.push(JSON.parse(String(r.scalar)));
      if (rows.length < this.policy.batch) break;
      after = Number(rows.at(-1)!.seq);
      await this.#yield(signal);
    }
    return values;
  }
  async #ledger(
    id: string,
    signal: AbortSignal,
    turn?: string,
  ): Promise<UsageLedger> {
    const ledger = new UsageLedger(id);
    for (const row of await this.#stored(id, signal, turn)) {
      if (row.usage) ledger.upsert(row.usage);
    }
    return ledger;
  }
  async detail(
    id: string,
    turnID: string,
    signal: AbortSignal,
  ): Promise<TurnUsageSnapshot> {
    await this.#ensure(id, signal);
    while (this.pending(id)) {
      await this.step(
        { sessionID: id, provider: this.identity, updated: 0, revision: 0 },
        {
          rows: this.policy.batch,
          until: performance.now() + this.policy.slicems,
        },
        signal,
      );
      await this.#yield(signal);
    }
    const ledger = await this.#ledger(id, signal, turnID),
      calls = ledger.detail(turnID);
    const labels = this.transcript.tools(id, calls.calls.map((c) => c.id));
    if (labels) {
      for (const row of labels) {
        ledger.tool(row.messageID, row.tool);
      }
    }
    return ledger.detail(turnID, this.storage.read(id)?.summary.revision ?? 0);
  }
  async transcriptMetadata(
    id: string,
    _turns: readonly string[],
    signal: AbortSignal,
    cutoff?: string,
    boundary?: import("@otk/harness").DigestBoundary,
  ): Promise<TranscriptMetadata> {
    const raw = await this.#ensure(id, signal);
    if (boundary) {
      if (!this.storage.read(id)) await this.hydrate([id], signal);
      const facts = await this.transcript.facts({
          sessionID: id,
          messages: [boundary.messageID],
          cutoff,
        }, signal),
        target = facts.contexts[boundary.messageID]?.order;
      while (
        this.pending(id) &&
        (this.#scan(id)?.after_seq == null || target === undefined ||
          this.#scan(id)!.after_seq! > target)
      ) {
        await this.step({
          sessionID: id,
          provider: this.identity,
          updated: millis(raw.time.updated),
          revision: 0,
        }, {
          rows: this.policy.batch,
          until: performance.now() + this.policy.slicems,
        }, signal);
        await this.#yield(signal);
      }
      this.readiness.demanded?.(metadata(raw));
    }
    return (await this.transcript.facts({
      sessionID: id,
      messages: [..._turns],
      cutoff,
    }, signal)).metadata;
  }
  async #helperStep(
    job: DigestJob,
    budget: DigestBudget,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const raw = await this.#ensure(job.sessionID, signal),
      source = this.#source;
    let scan = this.#helpers.get(job.sessionID);
    if (!scan || scan.source !== source) {
      const previous = Number(
        this.storage.sql.prepare(
          "SELECT MAX(generation) AS n FROM opcv2_transcript_helper WHERE session_id=?",
        ).get(job.sessionID)?.n ?? 0,
      );
      scan = {
        source,
        generation: Math.max(previous + 1, Date.now()),
        ...(this.#native && this.#helperValidated.has(job.sessionID) &&
            job.messages?.length
          ? { keys: [...new Set(job.messages)], offset: 0 }
          : {}),
      };
      this.#helpers.set(job.sessionID, scan);
    }
    const admitted = scan;
    const selected = scan.keys?.slice(
      scan.offset ?? 0,
      (scan.offset ?? 0) + Math.min(budget.rows, SCAN_ROWS),
    );
    let headers = scan.exhausted ? [] : this.transcript.sqlHeaders(
      job.sessionID,
      scan.before,
      Math.min(budget.rows, SCAN_ROWS),
      selected,
    );
    let next: string | undefined;
    let tools: ReturnType<TranscriptReads["tools"]>;
    if (headers) {
      tools = this.transcript.tools(
        job.sessionID,
        selected ?? headers.map((h) => h.id),
      );
    } else {
      const page = await this.messages.page(
        job.sessionID,
        Math.min(budget.rows, SCAN_ROWS),
        scan.cursor,
        signal,
      );
      next = page.next;
      headers = page.items.map((r, i) => scalarMessage(r, i));
      tools = page.items.flatMap((r) =>
        r.type !== "assistant"
          ? []
          : r.content.flatMap((p) =>
            p.type !== "tool" ? [] : [{
              messageID: r.id,
              tool: { id: partID(r.id, "tool", p.id), name: p.name },
              status: p.state.status,
              created: millis(p.time.created),
              completed: p.time.completed
                ? millis(p.time.completed)
                : undefined,
              child: text(
                record("metadata" in p.state ? p.state.metadata : undefined)
                  .sessionID,
              ),
            }]
          )
      );
    }
    signal.throwIfAborted();
    if (this.#helpers.get(job.sessionID) !== admitted) return "reconcile";
    this.storage.transaction(() => {
      if (selected) {
        this.storage.sql.prepare(
          "DELETE FROM opcv2_transcript_helper WHERE session_id=? AND message_id IN (SELECT value FROM json_each(?))",
        ).run(job.sessionID, JSON.stringify(selected));
      }
      for (const row of tools ?? []) {
        this.storage.sql.prepare(
          "INSERT INTO opcv2_transcript_helper(session_id,message_id,part_id,scalar,generation) VALUES (?,?,?,?,?) ON CONFLICT(session_id,message_id,part_id) DO UPDATE SET scalar=excluded.scalar,generation=excluded.generation",
        ).run(
          job.sessionID,
          row.messageID,
          row.tool.id,
          JSON.stringify(row),
          admitted.generation,
        );
      }
    });
    if (selected) admitted.offset = (admitted.offset ?? 0) + selected.length;
    const complete = selected
      ? admitted.offset! >= admitted.keys!.length
      : this.#native
      ? headers.length < Math.min(budget.rows, SCAN_ROWS)
      : !next;
    admitted.before = headers.at(-1)?.seq;
    admitted.cursor = next;
    if (!complete) return "continue";
    admitted.exhausted = true;
    const stale = selected ? [] : this.storage.sql.prepare(
      "SELECT message_id,part_id FROM opcv2_transcript_helper WHERE session_id=? AND generation<>? LIMIT ?",
    ).all(job.sessionID, admitted.generation, budget.rows);
    this.storage.sql.prepare(
      "DELETE FROM opcv2_transcript_helper WHERE session_id=? AND (message_id,part_id) IN (SELECT json_extract(value,'$.message_id'),json_extract(value,'$.part_id') FROM json_each(?))",
    ).run(job.sessionID, JSON.stringify(stale));
    if (stale.length === budget.rows) return "continue";
    const count = Number(
        this.storage.sql.prepare(
          "SELECT COUNT(*) AS n FROM opcv2_transcript_helper WHERE session_id=?",
        ).get(job.sessionID)!.n,
      ),
      last = this.storage.sql.prepare(
        "SELECT scalar FROM opcv2_transcript_helper WHERE session_id=? AND json_extract(scalar,'$.status') IN ('running','streaming') ORDER BY json_extract(scalar,'$.created') DESC LIMIT 1",
      ).get(job.sessionID),
      tool = last ? record(JSON.parse(String(last.scalar))) : undefined;
    const saved = this.storage.read(job.sessionID),
      helper: HelperSummary = {
        state: "ready",
        revision: (saved?.helper?.revision ?? 0) + 1,
        toolCount: count,
        ...(tool
          ? {
            current: {
              name: text(record(tool.tool).name) ?? "",
              title: text(record(tool.tool).summary),
              startedAt: typeof tool.created === "number"
                ? tool.created
                : undefined,
            },
          }
          : {}),
        time: {
          start: millis(raw.time.created),
          ...(raw.time.idle && millis(raw.time.idle) >= millis(raw.time.busy)
            ? { end: millis(raw.time.idle) }
            : {}),
        },
      };
    this.#helpers.delete(job.sessionID);
    this.#helperDirty.delete(job.sessionID);
    this.#helperValidated.add(job.sessionID);
    await this.#commit(metadata(raw), {
      summary: {
        ...(saved?.summary ?? { state: "digesting" }),
        revision: (saved?.summary.revision ?? 0) + 1,
      },
      helper,
      turns: { upsert: {}, remove: [] },
      deleted: null,
    });
    return;
  }
  async deleted(
    connection: number,
    id: string,
    _revision: number,
    entry?: SessionMetadata,
  ): Promise<void> {
    if (connection !== this.#connection) return;
    const saved = this.storage.read(id);
    if (!entry && !saved) return;
    await this.#commit(entry ?? saved!.metadata, {
      summary: {
        ...(saved?.summary ?? { state: "ready" }),
        revision: (saved?.summary.revision ?? 0) + 1,
      },
      turns: { upsert: {}, remove: [] },
      deleted: { at: Date.now(), how: "provider" },
    });
  }
  deleteIntent(
    _id: string,
    _intent: string,
    _phase: "begin" | "confirmed" | "failed",
    _connection: number,
  ): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    this.#closed = true;
    this.#client = undefined;
    this.#provenNative = undefined;
  }
}
