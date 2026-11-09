// SPDX-License-Identifier: LGPL-3.0-only
import {
  type DigestDelta,
  OperationFailure,
  type SessionMetadata,
  type TurnUsageSnapshot,
} from "@otk/protocol";
import {
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

export interface V2NativeConfig {
  serviceFile: string;
  db: string;
  requestms: number;
}
export interface V2DigestStorage {
  read(
    id: string,
  ): {
    metadata: SessionMetadata;
    summary: DigestDelta["summary"];
    deleted: DigestDelta["deleted"];
  } | undefined;
  write(metadata: SessionMetadata, delta: DigestDelta): void;
  publish(value: DigestPublication): void | Promise<void>;
  diagnostic(id: string | undefined, error: unknown): void;
}
export interface V2DigestReadiness {
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
  "opcv2.sessions": scalarSessionReadCodec,
  "opcv2.upgrade": upgradeReadCodec,
  "identity.batch": identityReadCodec,
  "sessions.list": sessionListReadCodec,
};
export const opencodeV2DigestMigrations = {
  feature: "opencode-v2-digest",
  migrations: [],
};

/** The same worker/scheduler/native permission as V1; no second SQL owner. */
export class OpencodeV2DigestSink implements DigestSink {
  readonly identity = "opencode-v2-server";
  readonly readers: ProviderReaders;
  readonly #lists = new V2SessionLists();
  #native?: V2NativeDb;
  #client?: V2Client;
  #connection = 0;
  #closed = false;
  #lifetime = new AbortController();
  #source?: string;
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
    this.readers = {
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
                } = await this.#io(
                  signal,
                  () =>
                    client.read(
                      (api) =>
                        api.session.get({ sessionID: ids.decode(key) }, {
                          signal,
                        }),
                      signal,
                    ),
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
    return await this.#io(signal, async () => {
      const service = await discoverV2(this.config.serviceFile, signal);
      const source =
        `${service.endpoint.url}:${service.pid}:${service.version}`;
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
    });
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
    const result = await this.#io(
      signal,
      () => this.#lists.read(input, client, this.#native, signal),
    );
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
            const row = await this.#io(
              signal,
              () =>
                client.read(
                  (api) =>
                    api.session.get({ sessionID: ids.decode(key) }, { signal }),
                  signal,
                ),
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
              await this.#io(signal, () =>
                client.read(
                  (api) =>
                    api.session.get({ sessionID: ids.decode(key) }, { signal }),
                  signal,
                )),
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
      { projects: reported } = await this.#prepare(signal);
    const projects: ProjectSeed[] = [];
    if (!this.#native) {
      // Unknown population is not an empty catalog and must not trigger enumeration.
      const rows = (directory === undefined
        ? reported.map((p) =>
          p.canonical
        )
        : [directory]).map((directory) => ({
          directory,
          sessionCount: null,
          lastActivity: null,
          authority: "unknown" as const,
        }));
      for (let at = 0; at < rows.length; at += this.policy.batch) {
        const page = rows.slice(at, at + this.policy.batch);
        projects.push(...page);
        await publish?.(page);
        await this.#yield(signal);
      }
      return { projects };
    }
    let after = "";
    for (;;) {
      this.#check(signal, connection);
      const rows = this.#native.projects(after, this.policy.batch, directory);
      if (!rows.length) break;
      projects.push(...rows);
      await publish?.(rows);
      after = rows.at(-1)!.directory;
      await this.#yield(signal);
    }
    if (directory !== undefined && !projects.length) {
      const row: ProjectSeed = {
        directory,
        hasSessions: false,
        sessionCount: 0,
        lastActivity: null,
        authority: "current",
      };
      projects.push(row);
      await publish?.([row]);
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
  pending(_id: string): boolean {
    return false;
  }
  invalidate(_id: string, _revision: number): void {
    this.#lists.invalidate();
  }
  invalidateHelper(_id: string): void {}
  requestHelper(_id: string, _changed: boolean): boolean {
    return false;
  }
  step(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  detail(): Promise<TurnUsageSnapshot> {
    return Promise.reject(
      new OperationFailure(
        "unavailable",
        "native.unavailable",
        new Error("V2 usage is not selected"),
      ),
    );
  }
  transcriptMetadata(): Promise<TranscriptMetadata> {
    return Promise.reject(
      new OperationFailure(
        "unavailable",
        "native.unavailable",
        new Error("V2 transcript metadata is not selected"),
      ),
    );
  }
  deleted(
    _connection: number,
    _id: string,
    _revision: number,
    _metadata?: SessionMetadata,
  ): Promise<void> {
    return Promise.reject(new Error("V2 deletion is not selected"));
  }
  deleteIntent(
    _id: string,
    _intent: string,
    _phase: "begin" | "confirmed" | "failed",
    _connection: number,
  ): Promise<void> {
    return Promise.reject(new Error("V2 deletion is not selected"));
  }
  close(): void {
    this.#closed = true;
    this.#lifetime.abort();
    this.#native?.close();
    this.#native = undefined;
  }
}
