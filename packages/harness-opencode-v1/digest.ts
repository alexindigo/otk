// SPDX-License-Identifier: LGPL-3.0-only
import { runningDirectories } from "./db-hints.ts";
import {
  projectFileMatches,
  projectSeeds,
  projectTopologyAt,
} from "./project-seeds.ts";
import { messageOutput, readMessageClock } from "./message-clock.ts";
import { catalogReaders } from "./catalog-reads.ts";
import { HistoryReader } from "./history.ts";
import { sessionDirectory } from "./directory.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  type DigestDelta,
  type HelperSummary,
  type SessionMetadata,
  type TurnUsageSnapshot,
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
import { digestRowFloor } from "@otk/harness";
import type { OpencodeV1Config } from "./config.ts";
import { harnessDb } from "./config.ts";
import { Client, HttpFailure, NativeRequestFailure } from "./client.ts";
import { Messages } from "./messages.ts";
import { mapIndex } from "./map.ts";
import type { Info, Session } from "./types.ts";
import { type DigestHeader, DigestNativeDb } from "./digest-db.ts";
import type { HelperToolRow } from "./digest-db.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { reportedNumber } from "./usage-values.ts";
import { NativeReadiness } from "./readiness.ts";
import { SessionLists } from "./session-lists.ts";

export interface DigestSnapshot {
  helper?: HelperSummary;
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
export interface OpencodeV1DigestReadiness {
  wait?<T>(readiness: Promise<T>, join?: boolean): Promise<T>;
  ioWait?<T>(readiness: Promise<T>, join?: boolean): Promise<T>;
  retryable?(error: unknown): boolean;
  admission?(signal: AbortSignal): Promise<() => void>;
  work?(elapsedMs: number): void;
  listed?(
    entries: readonly SessionMetadata[],
    signal: AbortSignal,
  ): Promise<void>;
  prefetchList?(
    input: import("@otk/protocol").SessionListInput,
    read: (signal: AbortSignal) => Promise<void>,
  ): void;
  demanded?(metadata: SessionMetadata): void;
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
/** Match SQLite's collection tuple order, not locale-sensitive text order. */
function newest(
  createdA: number,
  idA: string,
  createdB: number,
  idB: string,
): number {
  return createdB - createdA || (idA < idB ? 1 : idA > idB ? -1 : 0);
}
interface Replacement {
  previous?: Baseline;
  value?: Baseline;
}
interface Scan {
  source_generation?: string | null;
  source_mode?: string | null;
  after_created?: number | null;
  api_cursor?: string | null;
  covered_created?: number | null;
  covered_message?: string | null;
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
    result[key] = raw.role === "assistant"
      ? reportedNumber(raw[key], key !== "cost")
      : null;
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
    variant: info.model?.variant ?? null,
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
function baseline(
  value: DigestHeader,
  generation: number,
  digest: ArrayBuffer,
): Baseline {
  const hash = [
    ...new Uint8Array(
      digest,
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
  readonly readers: import("@otk/harness").ProviderReaders;
  readonly identity = "opencode-v1";
  #client: Client;
  #messages: Messages;
  #compute: NativeReadiness;
  #work?: (elapsedMs: number) => void;
  #native?: DigestNativeDb;
  #closed = false;
  #connection = 0;
  #connected = false;
  #nativeVerified = false;
  #projectVerified = false;
  #observation = 0;
  #observed = new Map<string, number>();
  #deletions = new Map<string, number>();
  #helperObserved = new Map<string, number>();
  #catalogWork?: {
    connection: number;
    observation: number;
    signal: AbortSignal;
    reconcile: boolean;
    task: Promise<
      { entries: SessionMetadata[]; authoritative: boolean; hints?: string[] }
    >;
  };
  #lists: SessionLists;
  #demanded?: (metadata: SessionMetadata) => void;
  #activeDirectories = new Set<string>();
  #excludedDirectories = new Set<string>();
  #discoveryRevision = 0;
  discoveryProject(directory: string, active: boolean): void {
    this.#discoveryRevision++;
    if (active) {
      this.#excludedDirectories.delete(directory);
      this.#activeDirectories.add(directory);
    } else this.#excludedDirectories.add(directory);
    this.#discoveryPosition = undefined;
    this.#discoveryAPICursor = undefined;
    this.#discoveryAPIComplete = false;
  }
  #discoveryPosition?: { updated: number; id: string };
  #discoveryAPICursor?: string;
  #discoveryAPIComplete = false;
  #apiGeneration = crypto.randomUUID();
  readonly wait: <T>(readiness: Promise<T>, join?: boolean) => Promise<T>;
  readonly retryable: (error: unknown) => boolean;
  constructor(
    readonly cfg: OpencodeV1Config,
    readonly policy: DigestPolicy,
    readonly storage: OpencodeV1DigestStorage,
    fetcher = fetch,
    readonly openNative: (file: string) => DigestNativeDb = (file) =>
      new DigestNativeDb(file),
    readiness: OpencodeV1DigestReadiness = {},
  ) {
    this.wait = readiness.wait ?? ((value) => value);
    this.retryable = readiness.retryable ?? (() => false);
    this.#demanded = readiness.demanded;
    this.#client = new Client(
      cfg.harness,
      fetcher,
      readiness.ioWait ?? this.wait,
      readiness.admission,
    );
    this.#lists = new SessionLists(
      this.#client,
      (signal) => this.#metadataSource(signal),
      this.wait,
    );
    this.readers = {
      "opcv1.message.prefetch": async (input, signal) => {
        const page = await this.#messages.page(
          input.sessionID,
          input.limit,
          input.before,
          input.directory,
          signal,
        );
        const turns = [
          ...new Set(
            page.items.filter((m) => m.info.role === "assistant").map((m) =>
              m.info.role === "assistant"
                ? m.info.parentID ?? m.info.id
                : m.info.id
            ),
          ),
        ];
        const oldest = page.items[0];
        const metadata = await this.transcriptMetadata(
          input.sessionID,
          turns,
          signal,
          input.cutoff,
          oldest &&
            { messageID: oldest.info.id, created: oldest.info.time.created },
        );
        return { page, metadata };
      },
      "sessions.list": async (input, signal) => {
        const health = await this.#client.json<{ healthy: boolean }>(
          "/global/health",
          { signal },
        );
        if (!health.healthy) {
          throw new NativeRequestFailure(
            "unavailable",
            new Error("Native provider is unavailable"),
            "native.unavailable",
          );
        }
        const result = await this.#lists.read(input, signal);
        for (const metadata of result.items) {
          signal.throwIfAborted();
          const previous = this.storage.read(metadata.id);
          if (previous?.deleted) continue;
          const changed = previous &&
            previous.metadata.timeUpdated !== metadata.timeUpdated;
          if (!previous || changed) {
            const delta = previous
              ? {
                ...emptyDelta(previous.summary.revision + 1),
                summary: {
                  ...previous.summary,
                  state: "digesting" as const,
                  revision: previous.summary.revision + 1,
                },
              }
              : emptyDelta();
            this.storage.transaction(() => {
              if (changed) {
                this.#invalidateScan(metadata.id, delta.summary.revision);
              }
              this.storage.write(metadata, delta);
            });
            await this.storage.publish({
              sessionID: metadata.id,
              revision: delta.summary.revision,
              delta,
              metadata,
            });
          }
        }
        await readiness.listed?.(result.items, signal);
        if (result.older) {
          const next = { ...input, before: result.older };
          readiness.prefetchList?.(next, async (signal) => {
            await this.#lists.read(next, signal);
          });
        }
        return result;
      },
      ...catalogReaders(this.#client),
      "message.clock": async (input, signal) => {
        const connection = this.#connection;
        const native = await this.#metadataSource(signal);
        signal.throwIfAborted();
        if (this.#closed || connection !== this.#connection) {
          throw new Error("Clock authority changed");
        }
        if (native && native.fileIdentity() === native.identity) {
          return readMessageClock(native.db, input.sessionID, input.messageID);
        }
        return messageOutput(
          (await this.#messages.get(input.sessionID, input.messageID, signal))
            .parts,
        );
      },
      "identity.batch": (input, signal) => this.identities(input.ids, signal),
      "history.list": (input, signal) =>
        this.#historyRead(
          signal,
          (reader) => reader.list(signal, input.directory),
        ),
      "history.entries": (input, signal) =>
        this.#historyRead(
          signal,
          (reader) => reader.entries(input.keys, signal),
        ),
      "history.attachments": (input, signal) =>
        this.#historyRead(
          signal,
          (reader) => reader.attachments(input.refs, signal),
        ),
    };
    this.#compute = new NativeReadiness(
      readiness.ioWait ?? this.wait,
      readiness.admission,
    );
    this.#work = readiness.work;
    this.#messages = new Messages(
      this.#client,
      (id) => storage.read(id)?.metadata.directory,
    );
    this.#open();
  }
  #open(): void {
    this.#nativeVerified = false;
    this.#projectVerified = false;
    try {
      this.#native = this.openNative(harnessDb(this.cfg));
    } catch (error) {
      this.storage.diagnostic(undefined, error);
    }
  }
  connection(value: number): void {
    if (value < this.#connection) return;
    if (!this.#connected || value !== this.#connection) {
      this.#lists.reset();
      this.#apiGeneration = crypto.randomUUID();
      this.#discoveryPosition = undefined;
      this.#discoveryAPICursor = undefined;
      this.#discoveryAPIComplete = false;
      this.#nativeVerified = false;
      this.#projectVerified = false;
      this.#observed.clear();
      this.#observation = 0;
      this.storage.sql.prepare(
        "DELETE FROM opcv1_delete_intents",
      ).run();
      this.#deletions.clear();
    }
    this.#connected = true;
    this.#connection = value;
  }
  async transcriptMetadata(
    sessionID: string,
    turns: readonly string[],
    signal: AbortSignal,
    cutoff?: string,
    boundary?: import("@otk/harness").DigestBoundary,
  ): Promise<import("@otk/harness").TranscriptMetadata> {
    signal.throwIfAborted();
    const native = await this.#metadataSource(signal);
    if (boundary) {
      if (!this.storage.read(sessionID)) {
        await this.hydrate([sessionID], signal);
      }
      const saved = this.storage.read(sessionID);
      if (saved && !saved.deleted) {
        this.#invalidateMissingScan(sessionID, saved.summary.revision);
        this.storage.sql.prepare(
          "UPDATE opcv1_scan SET requested_created=?,requested_message=? WHERE session_id=? AND (requested_created IS NULL OR (requested_created,requested_message)>(?,?))",
        ).run(
          boundary.created,
          boundary.messageID,
          sessionID,
          boundary.created,
          boundary.messageID,
        );
        while (!this.covered(sessionID, boundary)) {
          await this.step({
            provider: this.identity,
            sessionID,
            updated: saved.metadata.timeUpdated,
            revision: saved.summary.revision,
            boundary,
          }, {
            rows: this.policy.batch,
            until: performance.now() + this.policy.slicems,
          }, signal);
          if (this.storage.read(sessionID)?.summary.state === "unavailable") {
            throw new Error("Session metadata is unavailable");
          }
          await this.wait(new Promise((resolve) => setTimeout(resolve, 0)));
        }
        this.#demanded?.(saved.metadata);
      }
    }
    if (native && native === this.#native) {
      return native.transcriptMetadata(sessionID, turns, cutoff);
    }
    const boundaries = new Map<string, import("@otk/protocol").ReplyBoundary>();
    const wanted = new Set(turns);
    let prompt: import("@otk/protocol").LatestPrompt | undefined,
      created = -Infinity,
      cutoffCreated: number | undefined;
    let before: string | undefined;
    let satisfied = false;
    do {
      const page = await this.#messages.page(
        sessionID,
        this.policy.batch,
        before,
        undefined,
        signal,
      );
      const infos = page.items.map(({ info }) => info).sort((a, b) =>
        newest(a.time.created, a.id, b.time.created, b.id)
      );
      for (const info of infos) {
        if (info.id === cutoff) cutoffCreated = info.time.created;
        if (cutoff && info.id >= cutoff) continue;
        if (
          info.role === "user" &&
          (info.time.created > created ||
            (info.time.created === created && info.id > (prompt?.id ?? "")))
        ) {
          created = info.time.created;
          prompt = {
            id: info.id,
            ...(typeof info.agent === "string" ? { agent: info.agent } : {}),
            ...(info.model
              ? {
                model: {
                  provider: info.model.providerID,
                  model: info.model.modelID,
                },
                ...(typeof info.model.variant === "string"
                  ? { variant: info.model.variant }
                  : {}),
              }
              : {}),
          };
        }
        const turnID = info.parentID ?? info.id;
        if (info.role === "user") wanted.delete(info.id);
        if (
          prompt && !wanted.size && (!cutoff || cutoffCreated !== undefined)
        ) {
          satisfied = true;
          break;
        }
        if (info.role !== "assistant" || !wanted.has(turnID)) continue;
        const previous = boundaries.get(turnID);
        boundaries.set(turnID, {
          turnID,
          firstID: previous?.firstID && previous.firstID < info.id
            ? previous.firstID
            : info.id,
          lastID: previous?.lastID && previous.lastID > info.id
            ? previous.lastID
            : info.id,
          complete: info.time.completed !== undefined &&
            previous?.complete !== false,
        });
      }
      before = page.next;
    } while (before && !satisfied);
    return { prompt, boundaries: [...boundaries.values()], cutoffCreated };
  }
  covered(
    id: string,
    boundary: import("@otk/harness").DigestBoundary,
  ): boolean {
    const scan = this.storage.sql.prepare(
      "SELECT * FROM opcv1_scan WHERE session_id=?",
    ).get(id) as unknown as Scan | undefined;
    const source =
      (this.#nativeVerified || this.#projectVerified) && this.#native
        ? this.#native.identity
        : this.#apiGeneration;
    return !!scan && !scan.dirty && scan.source_generation === source &&
      (scan.complete_revision !== null && !scan.dirty ||
        scan.covered_created != null &&
          (scan.covered_created < boundary.created ||
            scan.covered_created === boundary.created &&
              (scan.covered_message ?? "") <= boundary.messageID));
  }
  pending(id: string): boolean {
    const saved = this.storage.read(id);
    if (!saved || saved.deleted) return false;
    const scan = this.storage.sql.prepare(
      "SELECT dirty,complete_revision FROM opcv1_scan WHERE session_id=?",
    ).get(id);
    return saved.summary.state !== "ready" ||
      !!scan && (!!scan.dirty || scan.complete_revision === null);
  }
  #invalidateMissingScan(id: string, revision: number): void {
    if (
      !this.storage.sql.prepare("SELECT 1 FROM opcv1_scan WHERE session_id=?")
        .get(id)
    ) this.#invalidateScan(id, revision);
  }
  /** Authority validation never borrows cached directory hints as evidence. */
  async #historyRead<T>(
    signal: AbortSignal,
    run: (reader: HistoryReader) => T | Promise<T>,
  ): Promise<T> {
    const connection = this.#connection;
    const native = await this.#metadataSource(signal);
    signal.throwIfAborted();
    if (!native) throw new Error("Provider history database is unavailable");
    const reader = new HistoryReader(
      () => {
        signal.throwIfAborted();
        if (
          this.#closed || connection !== this.#connection ||
          native.fileIdentity() !== native.identity
        ) throw new Error("Provider history authority changed");
        return native.db;
      },
      this.cfg.attachments,
      () => this.wait(new Promise((resolve) => setTimeout(resolve, 0))),
      (_level, message, error) =>
        this.storage.diagnostic(
          undefined,
          new Error(message, { cause: error }),
        ),
    );
    return await run(reader);
  }
  async identities(
    wanted: readonly string[],
    signal: AbortSignal,
  ): Promise<import("@otk/harness").SessionIdentity[]> {
    signal.throwIfAborted();
    const unique = [...new Set(wanted)];
    unique.forEach(ids.decode);
    if (!unique.length) return [];
    const connection = this.#connection;
    const health = await this.#client.json<{ healthy: boolean }>(
      "/global/health",
      { signal },
    );
    if (!health.healthy) {
      throw new NativeRequestFailure(
        "unavailable",
        new Error("Native provider is unavailable"),
        "native.unavailable",
      );
    }
    let native: DigestNativeDb | undefined;
    try {
      native = await this.#metadataSource(signal);
      if (native && native.fileIdentity() !== native.identity) {
        native = undefined;
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof NativeRequestFailure) throw error;
      native = undefined;
      this.storage.diagnostic(undefined, error);
    }
    signal.throwIfAborted();
    if (this.#closed || connection !== this.#connection) {
      throw new Error("Native identity generation changed");
    }
    if (native) {
      const result: import("@otk/harness").SessionIdentity[] = [];
      for (
        let offset = 0;
        offset < unique.length;
        offset += this.policy.batch
      ) {
        signal.throwIfAborted();
        if (
          this.#closed || connection !== this.#connection ||
          native.fileIdentity() !== native.identity
        ) throw new Error("Native identity authority changed");
        result.push(
          ...native.identities(
            unique.slice(offset, offset + this.policy.batch),
          ),
        );
        if (offset + this.policy.batch < unique.length) {
          await this.wait(
            new Promise<void>((resolve) => setTimeout(resolve, 0)),
          );
        }
      }
      return result;
    }
    const result = await sessionDirectory(
      (id) => this.storage.read(id)?.metadata.directory,
      (id, signal) =>
        this.#client.json<Session>(
          `/session/${encodeURIComponent(ids.decode(id))}`,
          { signal },
        ),
    ).validate(unique, signal);
    signal.throwIfAborted();
    if (this.#closed || connection !== this.#connection) {
      throw new Error("Native identity generation changed");
    }
    return result;
  }
  async hydrate(
    wanted: readonly string[],
    signal: AbortSignal,
  ): Promise<SessionMetadata[]> {
    const connection = this.#connection, admitted = this.#observation;
    const native = await this.#metadataSource(signal);
    const entries: SessionMetadata[] = [];
    for (let offset = 0; offset < wanted.length; offset += this.policy.batch) {
      signal.throwIfAborted();
      const keys = wanted.slice(offset, offset + this.policy.batch);
      const rows = native ? native.lookup(keys) : [];
      if (!native) {
        for (const id of keys) {
          try {
            const raw = await this.#client.json<Session>(
              `/session/${encodeURIComponent(ids.decode(id))}`,
              { signal },
            );
            rows.push(mapIndex(raw));
          } catch (error) {
            if (
              !(error instanceof NativeRequestFailure) ||
              !(error.original instanceof HttpFailure) ||
              error.original.status !== 404
            ) throw error;
          }
        }
      }
      signal.throwIfAborted();
      if (connection !== this.#connection && !this.#closed) {
        return await this.hydrate(wanted, signal);
      }
      if (
        this.#closed ||
        native && native.fileIdentity() !== native.identity
      ) throw new Error("Metadata demand authority changed");
      for (const id of keys) {
        const previous = this.storage.read(id);
        if (
          previous && !rows.some((row) => row.id === id) &&
          (this.#observed.get(id) ?? 0) <= admitted
        ) {
          await this.deleted(connection, id, 0);
        }
      }
      for (const metadata of rows) {
        const previous = this.storage.read(metadata.id);
        if (
          previous?.deleted && (this.#observed.get(metadata.id) ?? 0) > admitted
        ) continue;
        const changed = previous &&
          (previous.deleted ||
            previous.metadata.timeUpdated !== metadata.timeUpdated);
        const delta = previous
          ? {
            summary: {
              ...previous.summary,
              ...(changed
                ? {
                  state: "digesting" as const,
                  revision: previous.summary.revision + 1,
                }
                : {}),
            },
            turns: { upsert: {}, remove: [] },
            deleted: null,
          }
          : emptyDelta();
        this.storage.transaction(() => {
          if (changed) {
            this.#invalidateScan(metadata.id, delta.summary.revision);
          }
          this.storage.write(metadata, delta);
        });
        if (!previous) {
          await this.storage.publish({
            sessionID: metadata.id,
            revision: delta.summary.revision,
            metadata,
            delta,
          });
        }
        entries.push(metadata);
        this.#deletions.delete(metadata.id);
      }
      await this.wait(new Promise((resolve) => setTimeout(resolve, 0)));
    }
    return entries;
  }
  async projects(
    signal: AbortSignal,
    publish?: (projects: import("@otk/harness").ProjectSeed[]) => Promise<void>,
    directory?: string,
  ): Promise<
    { projects: import("@otk/harness").ProjectSeed[]; hints?: string[] }
  > {
    const connection = this.#connection;
    const native = this.#native;
    const projects: import("@otk/harness").ProjectSeed[] = [];
    if (!native) return { projects };
    try {
      const reported = await this.#client.json<
        import("./project-seeds.ts").NativeProjectRoot[]
      >("/project", { signal });
      if (!projectFileMatches(native.db, reported)) return { projects };
      this.#projectVerified = true;
      let after = "";
      for (;;) {
        signal.throwIfAborted();
        if (
          connection !== this.#connection ||
          native.fileIdentity() !== native.identity
        ) throw new Error("Project authority changed");
        const page = projectSeeds(
          native.db,
          after,
          this.policy.batch,
          directory,
          reported,
        );
        if (!page.length) break;
        projects.push(...page);
        for (const project of page) {
          if (project.hasSessions) {
            this.#activeDirectories.add(project.directory);
          } else this.#activeDirectories.delete(project.directory);
        }
        await publish?.(page);
        after = page.at(-1)!.directory;
        await this.wait(new Promise((resolve) => setTimeout(resolve, 0)));
      }
      if (directory === undefined) {
        const known = new Set(projects.map((seed) => seed.directory));
        for (const project of reported) {
          if (project.id === "global" || project.worktree === "/") continue;
          for (const root of [project.worktree, ...project.sandboxes ?? []]) {
            if (known.has(root)) continue;
            known.add(root);
            const empty: import("@otk/harness").ProjectSeed = {
              directory: root,
              hasSessions: false,
              sessionCount: 0,
              lastActivity: null,
              authority: "current",
              topology: {
                repoID: project.id,
                canonicalRoot: project.worktree,
                leafDirectory: root,
                ...(root !== project.worktree
                  ? { parentDirectory: project.worktree }
                  : {}),
              },
            };
            projects.push(empty);
            await publish?.([empty]);
          }
        }
      }
      if (directory !== undefined && !projects.length) {
        const empty: import("@otk/harness").ProjectSeed = {
          directory,
          hasSessions: false,
          sessionCount: 0,
          lastActivity: null,
          authority: "current",
          // No population repo ID remains: exact inventory proves a relationship,
          // but an unregistered nested scope is unknown, not an authoritative clear.
          topology: projectTopologyAt(reported, directory) ?? undefined,
        };
        projects.push(empty);
        await publish?.([empty]);
      }
      return {
        projects,
        hints: directory === undefined
          ? runningDirectories(native.db, 0)
          : undefined,
      };
    } catch (error) {
      signal.throwIfAborted();
      this.storage.diagnostic(undefined, error);
      return { projects: [] };
    }
  }
  /** Called only after requested high/normal work has drained. */
  async discover(
    signal: AbortSignal,
  ): Promise<{ entries: SessionMetadata[]; complete: boolean }> {
    signal.throwIfAborted();
    if (!this.#activeDirectories.size) {
      return { entries: [], complete: this.#projectVerified };
    }
    const revision = this.#discoveryRevision;
    const directories = [...this.#activeDirectories].filter((directory) =>
      !this.#excludedDirectories.has(directory)
    );
    if (!directories.length) return { entries: [], complete: true };
    let rows: SessionMetadata[], complete: boolean;
    if (this.#projectVerified && this.#native) {
      if (this.#native.fileIdentity() !== this.#native.identity) {
        throw new Error("Discovery source generation changed");
      }
      rows = this.#native.recent(
        directories,
        this.#discoveryPosition,
        this.policy.batch,
      );
      complete = !rows.length;
    } else {
      if (this.#discoveryAPIComplete) return { entries: [], complete: true };
      const response = await this.#client.request("/experimental/session", {
        query: { limit: this.policy.batch, cursor: this.#discoveryAPICursor },
        signal,
      });
      const page: Session[] = await this.wait(response.json());
      const next = response.headers.get("x-next-cursor") ?? undefined;
      if (next && (!page.length || next === this.#discoveryAPICursor)) {
        throw new Error("Session discovery cursor did not advance");
      }
      rows = page.filter((row) => directories.includes(row.directory)).map(
        mapIndex,
      );
      complete = !next;
      if (revision === this.#discoveryRevision) {
        this.#discoveryAPICursor = next;
        this.#discoveryAPIComplete = complete;
      }
    }
    for (const metadata of rows) {
      const saved = this.storage.read(metadata.id);
      if (!saved) {
        const delta = emptyDelta();
        this.storage.transaction(() => this.storage.write(metadata, delta));
        await this.storage.publish({
          sessionID: metadata.id,
          revision: 0,
          delta,
          metadata,
        });
      }
    }
    const last = rows.at(-1);
    if (last && revision === this.#discoveryRevision) {
      this.#discoveryPosition = {
        updated: last.timeUpdated,
        id: ids.decode(last.id),
      };
    }
    return { entries: rows, complete };
  }
  /** Scalar demand can prove this file with one bounded identity sample; it
   * neither waits for inventory exhaustion nor changes the scan cursor domain. */
  async #metadataSource(
    signal: AbortSignal,
  ): Promise<DigestNativeDb | undefined> {
    const native = this.#native;
    if (!native) return;
    if (this.#nativeVerified) return native;
    const connection = this.#connection;
    const response = await this.#client.request("/experimental/session", {
      query: { limit: 1 },
      signal,
    });
    const sample: Session[] = await this.wait(response.json());
    signal.throwIfAborted();
    if (
      this.#native !== native || this.#connection !== connection ||
      native.fileIdentity() !== native.identity
    ) return;
    const proof = native.lookup(sample.map((row) => ids.encode(row.id)));
    const matches = sample.length
      ? sample.every((row) =>
        proof.some((value) =>
          value.id === ids.encode(row.id) && value.directory === row.directory
        )
      )
      : native.catalog("", 1).length === 0;
    // The versioned checkpoint fences SQL/API transitions independently of a
    // population catalog; bounded point authority can establish this source.
    if (matches) this.#nativeVerified = true;
    return matches ? native : undefined;
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
      const rows: Session[] = await this.wait(response.json());
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
    const connection = this.#connection;
    const observation = this.#observation;
    for (;;) {
      signal.throwIfAborted();
      if (connection !== this.#connection) {
        throw new Error("Native catalog generation was replaced");
      }
      const active = this.#catalogWork;
      if (active) {
        try {
          const result = await this.wait(active.task);
          signal.throwIfAborted();
          if (
            active.connection === connection &&
            // Joining an enumeration cannot consume observations it predates.
            active.observation >= observation &&
            (active.reconcile || !reconcile)
          ) return result;
        } catch (error) {
          signal.throwIfAborted();
          if (!active.signal.aborted && active.connection === connection) {
            throw error;
          }
        }
        continue;
      }
      const admitted = this.#observation;
      const task = this.#catalog(signal, reconcile);
      const work = {
        connection,
        observation: admitted,
        signal,
        reconcile,
        task: task.finally(() => {
          if (this.#catalogWork === work) this.#catalogWork = undefined;
        }),
      };
      this.#catalogWork = work;
      return await work.task;
    }
  }
  async #catalog(
    signal: AbortSignal,
    reconcile: boolean,
  ): Promise<
    { entries: SessionMetadata[]; authoritative: boolean; hints?: string[] }
  > {
    if (this.#closed) throw new Error("Digest sink is closed");
    const connection = this.#connection;
    const current = () => {
      signal.throwIfAborted();
      if (connection !== this.#connection) {
        throw new Error("Native catalog generation was replaced");
      }
    };
    const health = await this.#client.json<{ healthy: boolean }>(
      "/global/health",
      { signal },
    );
    current();
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
          current();
          const page = db.catalog(after, this.policy.batch);
          if (!page.length) break;
          rows.push(...page);
          for (const id of db.emptySessions(page.map((entry) => entry.id))) {
            empty.add(id);
          }
          after = ids.decode(page.at(-1)!.id);
          await this.wait(new Promise((resolve) => setTimeout(resolve, 0)));
        }
        // Health plus an API identity sample binds this configured file to the service.
        const response = await this.#client.request("/experimental/session", {
          query: { limit: 1 },
          signal,
        });
        const sample: Session[] = await this.wait(response.json());
        current();
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
        current();
        if (this.retryable(error)) throw error;
        this.storage.diagnostic(undefined, error);
        this.#native?.close();
        this.#native = undefined;
        this.#nativeVerified = false;
        empty.clear();
      }
    }
    entries ??= await this.#apiCatalog(signal);
    current();
    const publications: DigestPublication[] = [];
    const old = this.storage.sql.prepare(
      "SELECT generation FROM opcv1_inventory WHERE singleton=1",
    ).get();
    const generation = Number(old?.generation ?? 0) + 1;
    const present = this.storage.sql.prepare(
      "INSERT INTO opcv1_presence VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET inventory_generation=excluded.inventory_generation",
    );
    const dirtyScan = this.storage.sql.prepare(
      "SELECT dirty FROM opcv1_scan WHERE session_id=?",
    );
    const found = new Set(entries.map((entry) => entry.id));
    const yieldChunk = async () => {
      await this.wait(new Promise<void>((resolve) => setTimeout(resolve, 0)));
      current();
    };
    for (let offset = 0; offset < entries.length; offset += this.policy.batch) {
      current();
      this.storage.transaction(() => {
        for (
          const metadata of entries!.slice(offset, offset + this.policy.batch)
        ) {
          present.run(metadata.id, generation);
          const previous = this.storage.read(metadata.id);
          // A pre-observation catalog row cannot revive an accepted retirement.
          if (
            previous?.deleted &&
            (this.#observed.get(metadata.id) ?? 0) > admitted
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
                state: needsScan
                  ? "digesting" as const
                  : previous.summary.state,
                revision: previous.summary.revision + 1,
              },
              turns: { upsert: {}, remove: [] },
              deleted: null,
            }
            : emptyDelta();
          // This is an authoritative empty scan, not an unknown total guessed as
          // zero. Existing nonempty baselines still take the normal sweep path.
          const dirty = dirtyScan.get(metadata.id)?.dirty;
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
      });
      await yieldChunk();
    }
    const retire = (batch: DigestSnapshot[]) =>
      this.storage.transaction(() => {
        for (const record of batch) {
          const previous = this.storage.read(record.metadata.id);
          if (!previous) continue;
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
    let missing: DigestSnapshot[] = [];
    for (const previous of this.storage.known()) {
      current();
      missing.push(previous);
      if (missing.length === this.policy.batch) {
        retire(missing);
        missing = [];
        await yieldChunk();
      }
    }
    if (missing.length) retire(missing);
    current();
    this.storage.transaction(() =>
      this.storage.sql.prepare(
        "INSERT INTO opcv1_inventory VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation,completed_at=excluded.completed_at,database_identity=excluded.database_identity",
      ).run(
        generation,
        Date.now(),
        this.#nativeVerified ? this.#native?.identity ?? null : null,
      )
    );
    for (const publication of publications) {
      current();
      await this.storage.publish(publication);
    }
    let hints: string[] | undefined;
    try {
      if (this.#nativeVerified && this.#native) {
        const candidates = new Set<string>();
        for (let at = 0; at < entries.length; at += this.policy.batch) {
          current();
          for (
            const directory of this.#native.hints(
              entries.slice(at, at + this.policy.batch).map((entry) =>
                entry.id
              ),
            )
          ) candidates.add(directory);
          await this.wait(new Promise((resolve) => setTimeout(resolve, 0)));
        }
        hints = [...candidates];
      }
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
    this.#lists.invalidate();
    this.#invalidateScan(id, revision);
  }
  #invalidateScan(id: string, revision: number): void {
    const native = ids.decode(id);
    this.storage.sql.prepare(
      "INSERT INTO opcv1_scan(session_id,native_id,after_message,scan_generation,observed_revision,complete_revision,dirty) VALUES(?,?,NULL,0,?,NULL,1) ON CONFLICT(session_id) DO UPDATE SET observed_revision=max(observed_revision,excluded.observed_revision),dirty=1,covered_created=NULL,covered_message=NULL",
    ).run(id, native, revision);
    this.#observed.set(id, ++this.#observation);
  }
  async deleted(
    connection: number,
    id: string,
    revision: number,
    metadata?: SessionMetadata,
  ): Promise<void> {
    ids.decode(id);
    if (connection !== this.#connection) return;
    if (revision <= (this.#deletions.get(id) ?? -1)) return;
    if (metadata && metadata.id !== id) {
      throw new Error("Deletion metadata identity mismatch");
    }
    const saved = this.storage.read(id);
    const previous = saved ??
      (metadata
        ? {
          metadata,
          summary: {
            ...emptyDelta().summary,
            nativeUpdatedAt: metadata.timeUpdated,
          },
          deleted: null,
        }
        : undefined);
    if (!previous) return;
    const intent = this.storage.sql.prepare(
      "SELECT 1 FROM opcv1_delete_intents WHERE session_id=? AND connection_generation=?",
    ).get(id, connection);
    if (previous.deleted && (!intent || previous.deleted.how === "otk")) {
      this.#deletions.set(id, revision);
      return;
    }
    const delta: DigestDelta = {
      summary: { ...previous.summary, revision: previous.summary.revision + 1 },
      turns: { upsert: {}, remove: [] },
      deleted: {
        at: previous.deleted?.at ?? Date.now(),
        how: intent ? "otk" : "provider",
      },
    };
    this.storage.transaction(() => {
      this.invalidate(id, revision);
      if (intent) {
        this.storage.sql.prepare(
          "UPDATE opcv1_delete_intents SET confirmed=1 WHERE session_id=? AND connection_generation=?",
        ).run(id, connection);
      }
      this.storage.write(previous.metadata, delta);
    });
    this.#deletions.set(id, revision);
    await this.storage.publish({
      sessionID: id,
      revision: delta.summary.revision,
      delta,
      ...(!saved ? { metadata: previous.metadata } : {}),
    });
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
        "variant",
        ...categories,
      ] as const;
      this.storage.sql.prepare(
        `INSERT INTO opcv1_messages(${columns.join(",")}) VALUES(${
          columns.map(() => "?").join(",")
        })`,
      ).run(
        ...columns.map((key) => key === "session_id" ? id : value[key] ?? null),
      );
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
    if (job.projection === "helper") {
      return await this.#helperStep(job, budget, signal);
    }
    const id = job.sessionID;
    ids.decode(id);
    signal.throwIfAborted();
    const snapshot = this.storage.read(id);
    if (!snapshot || snapshot.deleted) return;
    const admittedConnection = this.#connection;
    let scan = this.storage.sql.prepare(
      "SELECT * FROM opcv1_scan WHERE session_id=?",
    ).get(id) as unknown as Scan | undefined;
    const predecessor = {
      generation: scan?.scan_generation ?? 0,
      after: scan?.after_message ?? null,
      complete: scan?.complete_revision ?? null,
      source: scan?.source_generation ?? null,
      api: scan?.api_cursor ?? null,
      created: scan?.after_created ?? null,
    };
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
    const native = this.#nativeVerified || this.#projectVerified
      ? this.#native
      : undefined;
    const mode = native ? "sql" : "api";
    const source = native?.identity ?? this.#apiGeneration;
    const sourceChanged = scan.source_generation !== source;
    if (sourceChanged) {
      scan = {
        ...scan,
        after_message: null,
        after_created: null,
        api_cursor: null,
        complete_revision: null,
      };
    }
    const targeted = !!job.messages?.length &&
      (scan.complete_revision !== null || job.cursor?.startsWith("target:")) &&
      !!native;
    const targets = targeted
      ? job.messages!.slice(targetOffset, targetOffset + budget.rows)
      : [];
    const authority = () => {
      const saved = this.storage.read(id);
      if (!saved || saved.deleted || this.#connection !== admittedConnection) {
        return;
      }
      const checkpoint = this.storage.sql.prepare(
        "SELECT * FROM opcv1_scan WHERE session_id=?",
      ).get(id) as unknown as Scan | undefined;
      const changed =
        saved.metadata.directory !== snapshot.metadata.directory ||
        (native && native !== this.#native) ||
        (checkpoint?.scan_generation ?? 0) !== predecessor.generation ||
        (checkpoint?.after_message ?? null) !== predecessor.after ||
        (checkpoint?.complete_revision ?? null) !== predecessor.complete;
      const cursorChanged = changed ||
        (checkpoint?.source_generation ?? null) !== predecessor.source ||
        (checkpoint?.api_cursor ?? null) !== predecessor.api ||
        (checkpoint?.after_created ?? null) !== predecessor.created;
      return {
        saved,
        changed: cursorChanged,
        cursor:
          checkpoint?.complete_revision !== null && checkpoint?.dirty === 0
            ? undefined
            : "reconcile",
      };
    };
    const restart = !targeted &&
      (sourceChanged || (!job.cursor || job.cursor === "reconcile") &&
          (!(scan.after_message === "~sweep" ||
            (mode === "api" ? scan.api_cursor : scan.after_message)) ||
            scan.complete_revision !== null) ||
        !!job.boundary && !!scan.dirty);
    if (restart) {
      scan = {
        ...scan,
        scan_generation: scan.scan_generation + 1,
        after_message: null,
        after_created: null,
        api_cursor: null,
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
          scan.after_created == null
            ? undefined
            : { created: scan.after_created, messageID: scan.after_message! },
          job.boundary,
        );
        next = raw.length === budget.rows ? raw.at(-1)!.message_id : undefined;
      } else {
        const page = await this.#messages.page(
          id,
          Math.min(200, budget.rows),
          scan.api_cursor ?? undefined,
          snapshot.metadata.directory,
          signal,
        );
        raw = page.items.map((message) => fromInfo(message.info)).sort((a, b) =>
          newest(a.time_created, a.message_id, b.time_created, b.message_id)
        );
        next = page.next;
      }
    } catch (error) {
      signal.throwIfAborted();
      if (this.retryable(error)) throw error;
      const current = authority();
      if (!current) return;
      if (current.changed) return current.cursor;
      if (native) {
        this.storage.diagnostic(id, error);
        native.close();
        this.#native = undefined;
        this.#nativeVerified = false;
        // SQL IDs and opaque API cursors are different domains. Restart the
        // authoritative scan, retaining the last good neutral summary.
        this.storage.transaction(() => {
          if (initialize) this.#invalidateScan(id, job.revision);
          this.storage.sql.prepare(
            "UPDATE opcv1_scan SET after_message=NULL,after_created=NULL,api_cursor=NULL,source_mode='api',covered_created=NULL,covered_message=NULL,scan_generation=scan_generation+1,complete_revision=NULL,dirty=1 WHERE session_id=?",
          ).run(id);
        });
        return "retry-api";
      }
      const delta: DigestDelta = {
        summary: {
          ...current.saved.summary,
          state: "unavailable",
          revision: current.saved.summary.revision + 1,
        },
        turns: { upsert: {}, remove: [] },
        deleted: null,
      };
      this.storage.transaction(() =>
        this.storage.write(current.saved.metadata, delta)
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
    let hitBoundary = false;
    try {
      const values: ReturnType<typeof header>[] = [];
      for (const row of raw) {
        // SQL keysets subdivide the time budget; opaque API pages keep their
        // quota. An explicit boundary borrows Messages' native cursor encoder.
        if (
          native && !targeted &&
          values.length >= Math.min(budget.rows, digestRowFloor(this.policy)) &&
          performance.now() >= budget.until
        ) {
          next = raw[values.length - 1].message_id;
          break;
        }
        if (
          job.boundary && (row.time_created < job.boundary.created ||
            row.time_created === job.boundary.created &&
              row.message_id < job.boundary.messageID)
        ) {
          if (!native) {
            next = this.#messages.cursor(
              job.boundary.messageID,
              job.boundary.created,
            );
          }
          hitBoundary = true;
          break;
        }
        values.push(header(row));
        if (
          job.boundary && row.time_created === job.boundary.created &&
          row.message_id === job.boundary.messageID
        ) {
          hitBoundary = true;
          if (!native && values.length < raw.length) {
            next = this.#messages.cursor(row.message_id, row.time_created);
          }
          break;
        }
      }
      const hashes = await this.#compute.run(signal, () => {
        const started = performance.now();
        return Promise.all(
          values.map((value) =>
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify(value)),
            )
          ),
        ).then((hashes) => {
          this.#work?.(performance.now() - started);
          return hashes;
        });
      });
      rows = values.map((value, i) => baseline(value, generation, hashes[i]));
    } catch (error) {
      signal.throwIfAborted();
      if (this.retryable(error)) throw error;
      const current = authority();
      if (!current) return;
      if (current.changed) return current.cursor;
      const delta: DigestDelta = {
        summary: {
          ...current.saved.summary,
          state: "unavailable",
          revision: current.saved.summary.revision + 1,
        },
        turns: { upsert: {}, remove: [] },
        deleted: null,
      };
      this.storage.transaction(() =>
        this.storage.write(current.saved.metadata, delta)
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
    const current = authority();
    if (!current) return;
    if (current.changed) return current.cursor;
    const currentSaved = current.saved;
    const bounded = !!job.boundary && !targeted;
    const oldest = rows.at(-1);
    const reached = bounded &&
      (hitBoundary ||
        (native
          ? raw.length < budget.rows && rows.length === raw.length
          : !next) ||
        !!oldest &&
          (oldest.time_created < job.boundary!.created ||
            oldest.time_created === job.boundary!.created &&
              oldest.message_id <= job.boundary!.messageID));
    if (bounded) next = next ?? (native ? "boundary" : "sweep");
    let delta!: DigestDelta;
    this.storage.transaction(() => {
      // Scan admission and its first baseline/checkpoint share the commit. A
      // native read or hash may yield; preserve any newer invalidation it raced.
      if (initialize) this.#invalidateScan(id, job.revision);
      if (restart) {
        this.storage.sql.prepare(
          "UPDATE opcv1_scan SET scan_generation=?,after_message=NULL,after_created=NULL,api_cursor=NULL,covered_created=NULL,covered_message=NULL,complete_revision=NULL,dirty=CASE WHEN observed_revision>? THEN 1 ELSE 0 END WHERE session_id=?",
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
      const revision = currentSaved.summary.revision + 1;
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
          : mode === "sql"
          ? next ?? null
          : null,
        ready ? observed : null,
        ready ? 0 : Number(current.dirty),
        id,
      );
      if (!targeted) {
        const position = reached ? job.boundary : oldest &&
          { created: oldest.time_created, messageID: oldest.message_id };
        this.storage.sql.prepare(
          "UPDATE opcv1_scan SET source_mode=?,source_generation=?,after_created=?,after_message=CASE WHEN ?='sql' AND ? IS NOT NULL THEN ? ELSE after_message END,api_cursor=?,covered_created=?,covered_message=? WHERE session_id=?",
        ).run(
          mode,
          source,
          mode === "sql"
            ? position?.created ?? scan.after_created ?? null
            : null,
          next === "sweep" || next === "reconcile" ? "" : mode,
          position?.messageID ?? null,
          position?.messageID ?? null,
          mode === "api" && next &&
            !["boundary", "sweep", "reconcile"].includes(next)
            ? next
            : null,
          position?.created ?? scan.covered_created ?? null,
          position?.messageID ?? scan.covered_message ?? null,
          id,
        );
      }
      this.storage.write(currentSaved.metadata, delta, {
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
  /** Helper invalidations retain only identity. A full generation removes stale tools at its authoritative end. */
  invalidateHelper(id: string): void {
    ids.decode(id);
    this.#helperObserved.set(id, (this.#helperObserved.get(id) ?? 0) + 1);
    this.storage.sql.prepare(
      "INSERT INTO opcv1_helper_scan(session_id,after_part,scan_generation,dirty) VALUES(?,NULL,0,1) ON CONFLICT(session_id) DO UPDATE SET dirty=1",
    ).run(id);
  }
  /** Provider-private admission. Repeated hints never restart an active sweep. */
  requestHelper(id: string, changed: boolean): boolean {
    // An unknown helper also depends on fresh inventory admission, even when a
    // repeated hint preserves its already-dirty helper scan.
    if (!this.storage.read(id)) this.#observation++;
    const scan = this.storage.sql.prepare(
      "SELECT dirty FROM opcv1_helper_scan WHERE session_id=?",
    ).get(id);
    if (!scan || changed) this.invalidateHelper(id);
    return !scan || !!scan.dirty || changed || !this.storage.read(id)?.helper;
  }
  async #helperStep(
    job: DigestJob,
    budget: DigestBudget,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const id = job.sessionID, snapshot = this.storage.read(id);
    if (!snapshot || snapshot.deleted) return;
    const admittedConnection = this.#connection;
    const observation = this.#helperObserved.get(id) ?? 0;
    // The helper owns its independent tool projection cursor.
    let scan = this.storage.sql.prepare(
      "SELECT * FROM opcv1_helper_scan WHERE session_id=?",
    ).get(id);
    const predecessor = {
      generation: Number(scan?.scan_generation ?? 0),
      after: scan?.after_part ?? null,
      api: scan?.api_cursor ?? null,
      source: scan?.source_generation ?? null,
    };
    const native = this.#nativeVerified || this.#projectVerified
      ? this.#native
      : undefined;
    const mode = native ? "sql" : "api",
      source = native?.identity ?? this.#apiGeneration;
    const restart = !(scan?.after_part === "~sweep" ||
      (mode === "api" ? scan?.api_cursor : scan?.after_part)) ||
      !job.cursor ||
      job.cursor === "tools" || job.cursor === "reconcile" ||
      scan?.source_generation !== source;
    const generation = Number(scan?.scan_generation ?? 0) + (restart ? 1 : 0);
    const after = restart
      ? undefined
      : scan?.after_part === "~sweep"
      ? "~sweep"
      : (mode === "api" ? scan?.api_cursor : scan?.after_part) as
        | string
        | undefined;
    let start = restart ? undefined : scan?.time_start as number | undefined;
    let end = restart ? undefined : scan?.time_end as number | undefined;
    let unfinished = restart ? false : !!scan?.unfinished;
    const targeted = !!native && !!job.messages?.length &&
      (job.cursor?.startsWith("target-tools:") ||
        ((!job.cursor || job.cursor === "tools") &&
          snapshot.helper?.state === "ready"));
    let rows: HelperToolRow[] = [], next: string | undefined;
    try {
      if (after !== "~sweep") {
        if (native) {
          rows = native.helperTools(
            [id],
            ids.decode(id),
            after ?? "",
            budget.rows,
            targeted ? job.messages : undefined,
          );
          next = rows.length === budget.rows ? rows.at(-1)!.part_id : undefined;
        } else {
          const page = await this.#messages.page(
            id,
            Math.min(200, budget.rows),
            after,
            snapshot.metadata.directory,
            signal,
          );
          for (const { info } of page.items) {
            if (info.role === "user") {
              start = Math.min(start ?? Infinity, info.time.created);
            } else {
              if (info.time.completed === undefined) unfinished = true;
              else end = Math.max(end ?? -Infinity, info.time.completed);
            }
          }
          rows = page.items.flatMap(({ info, parts }) =>
            parts.filter((part) => part.type === "tool").map((part) => ({
              session_id: info.sessionID,
              message_id: info.id,
              part_id: part.id,
              name: part.tool!,
              title: part.state?.title ?? null,
              status: part.state?.status ?? "",
              time_start: part.state?.time?.start ?? null,
              message_created: info.time.created,
            }))
          );
          next = page.next;
        }
      }
      for (let index = 0; index < rows.length; index++) {
        if (
          native &&
          index >= Math.min(budget.rows, digestRowFloor(this.policy)) &&
          performance.now() >= budget.until
        ) {
          rows = rows.slice(0, index);
          next = rows.at(-1)!.part_id;
          break;
        }
        const row = rows[index];
        if (
          typeof row.name !== "string" ||
          !["pending", "running", "completed", "error"].includes(row.status) ||
          (row.title !== null && typeof row.title !== "string")
        ) throw new TypeError("Invalid helper tool metadata/JSON");
        counter(row.time_start, "helper start");
        counter(row.message_created, "helper message clock", false);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (this.retryable(error)) throw error;
      if (
        this.#connection !== admittedConnection ||
        this.storage.read(id)?.deleted
      ) return;
      if (native && !(error instanceof TypeError)) {
        this.storage.diagnostic(id, error);
        native.close();
        this.#native = undefined;
        this.#nativeVerified = false;
        this.#projectVerified = false;
        return "retry-api";
      }
      this.storage.diagnostic(id, error);
      const saved = this.storage.read(id)!;
      const revision = saved.summary.revision + 1;
      const delta: DigestDelta = {
        summary: { ...saved.summary, revision },
        turns: { upsert: {}, remove: [] },
        deleted: saved.deleted,
        helper: { state: "unavailable", revision, toolCount: null },
      };
      this.storage.transaction(() => this.storage.write(saved.metadata, delta));
      await this.storage.publish({ sessionID: id, revision, delta });
      return;
    }
    signal.throwIfAborted();
    if (
      this.#connection !== admittedConnection || this.storage.read(id)?.deleted
    ) return;
    const checkpoint = this.storage.sql.prepare(
      "SELECT scan_generation,after_part,api_cursor,source_generation FROM opcv1_helper_scan WHERE session_id=?",
    ).get(id);
    if (
      Number(checkpoint?.scan_generation ?? 0) !== predecessor.generation ||
      (checkpoint?.after_part ?? null) !== predecessor.after ||
      (checkpoint?.api_cursor ?? null) !== predecessor.api ||
      (checkpoint?.source_generation ?? null) !== predecessor.source
    ) return "reconcile";
    let delta!: DigestDelta;
    this.storage.transaction(() => {
      if (restart) {
        this.storage.sql.prepare(
          "INSERT INTO opcv1_helper_scan(session_id,after_part,scan_generation,dirty) VALUES(?,NULL,?,?) ON CONFLICT(session_id) DO UPDATE SET after_part=NULL,scan_generation=excluded.scan_generation,dirty=excluded.dirty",
        ).run(
          id,
          generation,
          (this.#helperObserved.get(id) ?? 0) === observation ? 0 : 1,
        );
      }
      const put = this.storage.sql.prepare(
        "INSERT INTO opcv1_helper_tools VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,part_id) DO UPDATE SET message_id=excluded.message_id,name=excluded.name,title=excluded.title,status=excluded.status,time_start=excluded.time_start,message_created=excluded.message_created,scan_generation=excluded.scan_generation",
      );
      for (const row of rows) {
        put.run(
          id,
          row.message_id,
          row.part_id,
          row.name,
          row.title,
          row.status,
          row.time_start,
          row.message_created,
          generation,
        );
      }
      if (!next) {
        const stale = this.storage.sql.prepare(
          "SELECT part_id FROM opcv1_helper_tools WHERE session_id=? AND scan_generation<>? AND (? IS NULL OR message_id IN (SELECT value FROM json_each(?))) LIMIT ?",
        ).all(
          id,
          generation,
          targeted ? JSON.stringify(job.messages) : null,
          targeted ? JSON.stringify(job.messages) : null,
          budget.rows,
        );
        for (const row of stale) {
          this.storage.sql.prepare(
            "DELETE FROM opcv1_helper_tools WHERE session_id=? AND part_id=?",
          ).run(id, row.part_id);
        }
        if (stale.length === budget.rows) next = "~sweep";
      }
      scan = this.storage.sql.prepare(
        "SELECT * FROM opcv1_helper_scan WHERE session_id=?",
      ).get(id)!;
      const ready = !next && !scan.dirty;
      if (!next && !ready) next = "reconcile";
      this.storage.sql.prepare(
        "UPDATE opcv1_helper_scan SET after_part=?,api_cursor=?,source_mode=?,source_generation=? WHERE session_id=?",
      ).run(
        next === "~sweep"
          ? "~sweep"
          : next === "reconcile" || mode === "api"
          ? null
          : next ?? null,
        mode === "api" && next !== "~sweep" && next !== "reconcile"
          ? next ?? null
          : null,
        mode,
        source,
        id,
      );
      const saved = this.storage.read(id)!;
      const revision = saved.summary.revision + 1;
      const count = Number(
        this.storage.sql.prepare(
          "SELECT count(*) AS n FROM opcv1_helper_tools WHERE session_id=?",
        ).get(id)!.n,
      );
      const current = this.storage.sql.prepare(
        "SELECT name,title,time_start FROM opcv1_helper_tools WHERE session_id=? AND status<>'pending' ORDER BY coalesce(time_start,0) DESC,message_created DESC,message_id DESC,part_id DESC LIMIT 1",
      ).get(id);
      const time = native && ready
        ? native.db.prepare(
          "SELECT min(CASE WHEN json_extract(data,'$.role')='user' THEN time_created END) AS start,max(json_extract(data,'$.time.completed')) AS end,sum(json_extract(data,'$.role')='assistant' AND json_extract(data,'$.time.completed') IS NULL) AS unfinished FROM message WHERE session_id=? AND json_valid(data)",
        ).get(ids.decode(id))!
        : { start: start ?? null, end: end ?? null, unfinished };
      this.storage.sql.prepare(
        "UPDATE opcv1_helper_scan SET time_start=?,time_end=?,unfinished=? WHERE session_id=?",
      ).run(time.start, time.end, Number(!!time.unfinished), id);
      const helper: HelperSummary = {
        state: ready ? "ready" : "digesting",
        revision,
        toolCount: ready ? count : null,
        ...(ready && current
          ? {
            current: {
              name: String(current.name),
              ...(current.title === null
                ? {}
                : { title: String(current.title) }),
              ...(current.time_start === null
                ? {}
                : { startedAt: Number(current.time_start) }),
            },
          }
          : {}),
        ...(time.start === null ? {} : {
          time: {
            start: Number(time.start),
            ...(time.end === null || time.unfinished
              ? {}
              : { end: Number(time.end) }),
          },
        }),
      };
      delta = {
        summary: { ...saved.summary, revision },
        turns: { upsert: {}, remove: [] },
        deleted: saved.deleted,
        helper,
      };
      this.storage.write(saved.metadata, delta);
    });
    await this.storage.publish({
      sessionID: id,
      revision: delta.summary.revision,
      delta,
    });
    return targeted && next && next !== "reconcile"
      ? `target-tools:${next}`
      : next;
  }
  async detail(
    id: string,
    turnID: string,
    signal: AbortSignal,
  ): Promise<TurnUsageSnapshot> {
    ids.decode(id);
    let saved = this.storage.read(id);
    if (!saved) throw new Error("Session usage is unavailable");
    if (saved.deleted) {
      throw new Error("Session usage is unavailable for a deleted session");
    }
    const scan = this.storage.sql.prepare(
      "SELECT dirty,observed_revision,complete_revision FROM opcv1_scan WHERE session_id=?",
    ).get(id);
    if (
      this.#nativeVerified && this.#native &&
      (saved.summary.state !== "ready" || scan?.dirty === 1 ||
        scan?.observed_revision !== scan?.complete_revision)
    ) {
      // Explicit detail already holds the scheduler's interactive read slot. Finish
      // its scalar baseline in bounded slices before reading this one turn.
      let cursor: string | undefined;
      do {
        signal.throwIfAborted();
        cursor = await this.step({
          provider: this.identity,
          sessionID: id,
          directory: saved.metadata.directory,
          updated: saved.metadata.timeUpdated,
          revision: saved.summary.revision,
          cursor,
        }, {
          rows: this.policy.batch,
          until: performance.now() + this.policy.slicems,
        }, signal);
        saved = this.storage.read(id)!;
        if (cursor) {
          await this.wait(new Promise((resolve) => setTimeout(resolve, 0)));
        }
      } while (cursor);
      if (saved.summary.state !== "ready") {
        throw new Error("Usage metadata is unavailable");
      }
    }
    const metadata = saved.metadata;
    const ledger = new UsageLedger(id);
    const consume = (row: DigestHeader): UsageMessage | undefined => {
      row = header(row);
      if (
        row.role !== "assistant" || (row.turn_id ?? row.message_id) !== turnID
      ) return;
      if (!row.provider_id || !row.model_id) {
        throw new Error("Detailed usage model is unavailable");
      }
      return {
        id: row.message_id,
        turnID: row.turn_id ?? row.message_id,
        model: { provider: row.provider_id, model: row.model_id },
        tokens: {
          input: row.input,
          output: row.output,
          reasoning: row.reasoning,
          cache: { read: row.cache_read, write: row.cache_write },
        },
        cost: row.cost,
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
        const rows = this.storage.sql.prepare(
          "SELECT * FROM opcv1_messages WHERE session_id=? AND turn_id=? AND message_id>? AND role='assistant' ORDER BY message_id LIMIT ?",
        ).all(
          id,
          turnID,
          after,
          this.policy.batch,
        ) as unknown as DigestHeader[];
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
          await this.wait(new Promise((resolve) => setTimeout(resolve, 0)));
          signal.throwIfAborted();
        }
        after = rows.at(-1)!.message_id;
        await this.wait(new Promise((resolve) => setTimeout(resolve, 0)));
      }
    } else {for await (
        const message of this.#messages.scan(id, metadata.directory, signal)
      ) {
        const usage = consume(fromInfo(message.info));
        if (usage) ledger.upsert(usage);
        // Only existing tool labels leave the fallback page; bodies are released.
        for (const part of usage ? message.parts : []) {
          if (part.type === "tool" && part.tool) {
            ledger.tool(message.info.id, {
              id: part.id,
              name: part.tool,
              ...(part.state?.title ? { summary: part.state.title } : {}),
            });
          }
        }
      }}
    return ledger.detail(turnID, saved.summary.revision);
  }
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#native?.close();
      this.#native = undefined;
    }
  }
}
