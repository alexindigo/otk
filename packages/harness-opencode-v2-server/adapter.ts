// SPDX-License-Identifier: LGPL-3.0-only
import {
  type DigestPolicy,
  type DigestPort,
  type Harness,
  type HarnessCore,
  HarnessError,
  type HarnessSink,
  type ProviderReadPort,
  SessionIndex,
} from "@otk/harness";
import type {
  Capabilities,
  ContentSession,
  SessionMetadata,
} from "@otk/protocol";
import { type DiscoveredService, discoverV2 } from "./discovery.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { type V2Event, V2Stream } from "./stream.ts";
import { type V2Client, V2MissingSession } from "./client.ts";
import { metadata, millis, session, type SessionFacts } from "./metadata.ts";
import { V2SessionLists } from "./session-lists.ts";
import { V2Catalogs } from "./catalogs.ts";
import { Transcript } from "./transcript.ts";
import { revertSession, sessionActions } from "./session-actions.ts";
import { commands } from "./commands.ts";

export interface OpencodeV2ServerConfig {
  serviceFile: string;
  harness: {
    requestms: number;
    reconnectmax: number;
    heartbeattimeout: number;
  };
  messages: import("@otk/protocol").MessagePolicy;
  digest?: DigestPolicy;
  catalogs?: { pending: number; concurrency: number };
  attachments?: import("@otk/protocol").AttachmentPolicy;
}
type Pending = {
  id: string;
  sessionID: string;
  kind: "permission" | "form";
  directory: string;
  stale?: boolean;
};
/** V0 supplies the connection owner. Capabilities are added only with their proofs. */
export class OpencodeV2ServerAdapter implements Harness {
  readonly core: HarnessCore;
  readonly capabilities: Readonly<Capabilities>;
  readonly digest?: DigestPort;
  readonly catalogs?: V2Catalogs;
  readonly stream: V2Stream;
  readonly transcript: Transcript;
  #sink?: HarnessSink;
  #index = new SessionIndex();
  #pending = new Map<string, Pending>();
  #pendingCounts = new Map<
    string,
    { permissions: number; questions: number; stale: number }
  >();
  #settledPending = new Set<string>();
  #running = new Map<string, number>();
  #finished = new Map<string, number>();
  #version = "";
  #generation = 0;
  #lists = new V2SessionLists();
  #activityCurrent = false;
  #observation = 0;
  #helperListener?: () => void;
  constructor(
    readonly config: OpencodeV2ServerConfig,
    initial?: DiscoveredService,
    readonly diagnostic: (error: unknown) => void = () => {},
    fetcher: typeof fetch = fetch,
    reads?: ProviderReadPort,
  ) {
    const digest = this.digest = reads && "start" in reads
      ? reads as DigestPort
      : undefined;
    this.#version = initial?.version ?? "";
    this.stream = new V2Stream(
      {
        admission: (signal) =>
          digest?.admission?.(signal) ?? Promise.resolve(() => {}),
        discover: async (signal) => {
          const service = await discoverV2(config.serviceFile, signal);
          if (service.version !== "2.2.6") {
            diagnostic(
              new Error(
                `Opencode ${service.version} is untested; qualified V2 version is 2.2.6.`,
              ),
            );
          }
          return service;
        },
        resync: (client, signal, generation) =>
          this.#resync(client, signal, generation),
        event: (event, client, signal, generation) =>
          this.#event(event, client, signal, generation),
        connected: (client, generation) => {
          this.#activityCurrent = true;
          this.#version = client.service.version;
          this.#generation = generation;
          this.#lists.reset();
          this.catalogs?.reset();
          this.#sink?.connection("connected");
          this.#sink?.bootstrapComplete();
        },
        disconnected: (generation) => {
          this.#activityCurrent = false;
          this.transcript.disconnect();
          this.#generation = generation;
          this.#lists.reset();
          for (const entry of this.#index.snapshotEntries()) {
            const { digest: _digest, ...metadata } = entry;
            this.#upsert({
              ...metadata,
              activityAuthority: "stale",
            });
          }
          this.#sink?.connection("reconnecting");
        },
        diagnostic,
      },
      { ...config.harness, ...config.messages, heartbeattimeout: 45 },
      fetcher,
      digest?.admission?.bind(digest),
    );
    this.transcript = new Transcript({
      client: () => this.stream.client,
      policy: config.messages,
      digest,
      content: (id, event, clock) => this.#sink?.content(id, event, clock),
      invalidated: (value) => this.#sink?.invalidate(value),
      diagnostic,
      summaries: (id, turns) => {
        const entry = this.#index.snapshotEntry(id);
        return Object.fromEntries(
          turns.flatMap((turn) =>
            entry?.digest.turns[turn] ? [[turn, entry.digest.turns[turn]]] : []
          ),
        );
      },
      helper: (id) => this.#index.helper(id),
      requestHelper: digest
        ? (id) =>
          digest.observe(this.#generation, [{
            sessionID: id,
            revision: 0,
            reason: "helper-hint",
          }])
        : undefined,
    });
    const digestCapabilities: Capabilities = digest
      ? {
        usage: {
          getUsage: async (
            id: string,
            turnID: string,
            signal?: AbortSignal,
          ) => {
            ids.decode(id);
            const clock = this.transcript.replay.clock(id),
              version = this.transcript.replay.version(id);
            const value = await digest.detail(
              id,
              turnID,
              signal ?? new AbortController().signal,
            );
            return { ...value, clock, version };
          },
        },
        digests: {
          scope: (
            owner: string,
            value: { directory?: string; sessions: string[] },
          ) => digest.scope(owner, value),
          release: (owner: string) => digest.release(owner),
        },
      }
      : {};
    if (config.digest && config.catalogs) {
      this.catalogs = new V2Catalogs(
        () => this.stream.client,
        async (id, signal) =>
          (await this.stream.client.read(
            (api) => api.session.get({ sessionID: ids.decode(id) }, { signal }),
            signal,
          )).location.directory,
        config.digest,
        config.catalogs,
        diagnostic,
        reads,
      );
    }
    const catalogCapabilities: Capabilities = this.catalogs
      ? {
        agents: this.catalogs.agents,
        models: this.catalogs.models,
        files: this.catalogs.files,
        catalogs: {
          watch: (directory, listener, signal) =>
            this.catalogs!.watch(directory, listener, signal),
          refresh: (directory, signal) =>
            this.catalogs!.refresh(directory, signal),
        },
        ...(this.catalogs.history ? { history: this.catalogs.history } : {}),
        // Catalog metadata remains available. V2 cannot materialize MCP URI inputs.
      }
      : {};
    this.capabilities = Object.freeze({
      ...digestCapabilities,
      ...catalogCapabilities,
      commands: commands(
        () => this.stream.client,
        config.attachments,
        this.catalogs
          ? (id, signal) => this.catalogs!.listCommands(id, signal)
          : undefined,
      ),
      ...sessionActions({
        client: () => this.stream.client,
        observed: (raw) => {
          this.transcript.observe(raw);
          // Native terminal clocks, not an old event, certify the action's
          // current lamp. In particular Restore owns its clear-triggered run.
          const busy = millis(raw.time.busy) > millis(raw.time.idle);
          if (busy) this.#running.set(raw.id, millis(raw.time.busy));
          else this.#running.delete(raw.id);
          this.#upsert(this.#metadata(raw, busy));
        },
        removed: async (id, operation) => {
          const client = this.stream.client;
          const native = ids.decode(id);
          const raw = await client.read(
            (api) =>
              api.session.get({ sessionID: native }, {
                signal: operation?.signal,
              }),
            operation?.signal,
          );
          const metadata = this.#metadata(raw, this.#running.has(native));
          const intent = crypto.randomUUID(), generation = this.#generation;
          await digest?.deleteIntent(id, intent, "begin", generation);
          try {
            await client.effect(
              (api) => api.session.remove({ sessionID: native }),
              operation,
            );
            await digest?.deleteIntent(id, intent, "confirmed", generation);
            await this.#deleted(id, metadata, generation);
          } catch (error) {
            await digest?.deleteIntent(id, intent, "failed", generation);
            throw error;
          }
        },
      }),
    });
    const version = () => this.#version;
    const unavailable = () =>
      Promise.reject(
        new HarnessError(
          "capability",
          "This V2 area is not available in this foundation build.",
        ),
      );
    this.core = {
      kind: "opencode-v2-server",
      get version() {
        return version();
      },
      start: async (sink) => {
        if (this.#sink) {
          throw new HarnessError("started", "Harness is already started");
        }
        this.#index = sink.index ?? new SessionIndex();
        this.#helperListener = this.#index.observeDigest((id) => {
          const summary = this.#index.helper(id);
          if (summary) this.transcript.helper(id, summary);
        });
        this.#sink = sink;
        this.transcript.start();
        sink.connection("connecting");
        try {
          await digest?.start();
          await this.stream.start();
        } catch (error) {
          await this.stream.stop();
          await digest?.stop();
          this.#sink = undefined;
          throw error;
        }
      },
      stop: async () => {
        // Retire the publication port synchronously before joining any read.
        this.#sink = undefined;
        await this.catalogs?.stop();
        this.#helperListener?.();
        this.#helperListener = undefined;
        await this.stream.stop();
        await this.transcript.stop();
        await digest?.stop();
        this.#pending.clear();
        this.#pendingCounts.clear();
        this.#settledPending.clear();
        this.#running.clear();
        this.#finished.clear();
      },
      subscriptions: (id, count) => this.transcript.subscriptions(id, count),
      hydrate: (keys, signal = new AbortController().signal) =>
        this.#hydrate(keys, signal),
      identities: async (keys, signal) => {
        keys.forEach(ids.decode);
        if (digest) {
          return await digest.read("identity.batch", { ids: [...keys] }, {
            owner: `identity:${crypto.randomUUID()}`,
            priority: "user",
            signal,
          });
        }
        const result = [];
        const batch = [...new Set(keys)].map((key) => ({
          key,
          native: ids.decode(key),
        }));
        for (const { key, native } of batch) {
          try {
            const raw = await this.stream.client.read((api) =>
              api.session.get({
                sessionID: native,
              }, { signal }), signal);
            signal?.throwIfAborted();
            result.push({
              id: key,
              directory: raw.location.directory,
              ...(raw.parentID ? { parentID: ids.encode(raw.parentID) } : {}),
            });
          } catch (error) {
            if (error instanceof V2MissingSession) continue;
            throw error;
          }
        }
        return result;
      },
      getSession: async (id, signal) => {
        const native = ids.decode(id);
        const raw = await this.stream.client.read((api) =>
          api.session.get({
            sessionID: native,
          }, { signal }), signal);
        this.transcript.observe(raw);
        return await revertSession(this.stream.client, raw, signal);
      },
      listSessions: async (input, signal = new AbortController().signal) => {
        if (input.parentID) ids.decode(input.parentID);
        const result = digest
          ? await digest.read("sessions.list", input, {
            owner: `sessions:${crypto.randomUUID()}`,
            priority: "user",
            signal,
          })
          : await this.#lists.read(
            input,
            this.stream.client,
            undefined,
            signal,
          );
        for (const row of result.items) this.#merge(row);
        return {
          ...result,
          items: result.items.map((row) =>
            this.#index.getMetadata(row.id) ?? row
          ),
        };
      },
      listChildren: async (id, signal) => {
        const native = ids.decode(id),
          result: ContentSession[] = [],
          seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await this.stream.client.read(
            (api) =>
              api.session.list(
                cursor
                  ? { cursor, limit: 200 }
                  : { parentID: native, limit: 200, order: "desc" },
                { signal },
              ),
            signal,
          );
          for (const raw of page.data) {
            result.push(session(raw));
            this.#merge(metadata(raw));
          }
          const next = page.cursor.next;
          if (next && (seen.has(next) || !page.data.length)) {
            throw new Error("Child cursor did not advance");
          }
          if (next) seen.add(next);
          cursor = next ?? undefined;
        } while (cursor);
        return result;
      },
      listMessages: (id, input, signal) =>
        this.transcript.page(id, input?.before, signal, input?.publish),
      createSession: unavailable,
    };
  }
  #upsert(entry: SessionMetadata): void {
    if (!this.#sink) return;
    if (!this.#sink.index) this.#index.upsertMetadata(entry);
    this.#sink.indexUpsert(entry);
  }
  #merge(row: SessionMetadata): void {
    const current = this.#index.getMetadata(row.id);
    if (current && current.timeUpdated > row.timeUpdated) row = { ...current };
    const native = ids.decode(row.id),
      pending = this.#pendingCounts.get(native);
    this.#upsert({
      ...row,
      status: this.#running.has(native)
        ? "busy"
        : this.#activityCurrent
        ? "idle"
        : current?.status ?? row.status,
      retry: current?.retry,
      attention: {
        ...(current?.attention ?? row.attention),
        permissions: pending?.permissions ?? 0,
        questions: pending?.questions ?? 0,
      },
      activityAuthority: pending?.stale
        ? "unknown"
        : this.#activityCurrent
        ? "current"
        : current?.activityAuthority ?? "unknown",
    });
  }
  #execution(
    entry: SessionMetadata,
    ended?: number,
    alreadyObserved = false,
  ): void {
    if (!ended || ended <= (this.#finished.get(entry.id) ?? 0)) {
      this.#upsert(entry);
      return;
    }
    this.#finished.set(entry.id, ended);
    // A native execution edge is not canceled by a newer metadata snapshot.
    // Replay its one finish transition through the existing synchronous index
    // observer, then retain the snapshot's truthful current activity.
    if (!alreadyObserved) {
      if (this.#index.getMetadata(entry.id)?.status !== "busy") {
        this.#upsert({
          ...entry,
          status: "busy",
          retry: undefined,
          attention: { ...entry.attention, error: undefined },
        });
      }
      this.#upsert({ ...entry, status: "idle", retry: undefined });
    }
    if (alreadyObserved || entry.status !== "idle") this.#upsert(entry);
  }
  async #hydrate(
    wanted: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    // Retained references from an unproven provider transition remain user data,
    // not native V2 identities. Optional hydration must not block valid keys.
    wanted = wanted.filter(ids.is);
    if (!wanted.length) return;
    if (this.digest?.hydrate) {
      await this.digest.hydrate(wanted, signal);
      signal.throwIfAborted();
      const keys = new Set(wanted);
      for (const key of keys) {
        const row = this.#index.getMetadata(key);
        if (row) {
          this.#merge(row);
          if (row.parentID) keys.add(row.parentID);
        }
      }
      return;
    }
    const remaining = [...new Set(wanted)], seen = new Set<string>();
    while (remaining.length) {
      signal.throwIfAborted();
      const key = remaining.shift()!;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const raw = await this.stream.client.read(
          (api) => api.session.get({ sessionID: ids.decode(key) }, { signal }),
          signal,
        );
        this.#merge(metadata(raw));
        if (raw.parentID) remaining.push(ids.encode(raw.parentID));
      } catch (error) {
        if (!(error instanceof V2MissingSession)) throw error;
      }
    }
  }
  async #deleted(
    id: string,
    metadata: SessionMetadata | undefined,
    generation: number,
  ): Promise<void> {
    if (generation !== this.#generation) return;
    const previous = this.#index.getMetadata(id);
    this.transcript.release(id);
    this.#running.delete(ids.decode(id));
    this.#finished.delete(id);
    this.#lists.invalidate();
    for (const [key, pending] of this.#pending) {
      if (pending.sessionID === ids.decode(id)) this.#setPending(key);
    }
    if (this.digest) {
      await this.digest.deleted(generation, id, Date.now(), metadata);
    } else {
      if (!this.#sink?.index) this.#index.remove(id);
      this.#sink?.indexRemove(id);
    }
    if (previous) {
      await this.#refreshProjects(
        [previous.directory],
        this.stream.client.signal,
        generation,
      );
    }
  }
  #metadata(raw: SessionFacts, busy: boolean): SessionMetadata {
    const mapped = session(raw);
    const pending = this.#pendingCounts.get(raw.id);
    return {
      id: mapped.id,
      parentID: mapped.parentID,
      directory: mapped.directory,
      projectID: mapped.projectID,
      title: mapped.title,
      timeCreated: mapped.time.created,
      timeUpdated: mapped.time.updated,
      archived: mapped.archived,
      status: busy ? "busy" : "idle",
      activityAuthority: pending?.stale ? "unknown" : "current",
      ...(busy && this.#index.getMetadata(mapped.id)?.retry
        ? { retry: this.#index.getMetadata(mapped.id)!.retry }
        : {}),
      attention: {
        permissions: pending?.permissions ?? 0,
        questions: pending?.questions ?? 0,
        childPermissions: 0,
        childQuestions: 0,
        ...(!busy && raw.outcome === "failed"
          ? { error: "Execution failed." }
          : {}),
      },
    };
  }
  #countPending(row: Pending, delta: 1 | -1): void {
    const count = this.#pendingCounts.get(row.sessionID) ??
      { permissions: 0, questions: 0, stale: 0 };
    count[row.kind === "permission" ? "permissions" : "questions"] += delta;
    if (row.stale) count.stale += delta;
    if (count.permissions || count.questions) {
      this.#pendingCounts.set(row.sessionID, count);
    } else this.#pendingCounts.delete(row.sessionID);
  }
  #setPending(key: string, row?: Pending): void {
    const previous = this.#pending.get(key);
    if (previous) this.#countPending(previous, -1);
    if (row) {
      this.#pending.set(key, row);
      this.#countPending(row, 1);
    } else this.#pending.delete(key);
  }
  #pendingEvent(event: V2Event, sid: unknown, form: unknown): void {
    const kind = event.type.startsWith("permission.") ? "permission" : "form";
    const created = event.type === "permission.asked" ||
      event.type === "form.created";
    const settled = event.type === "permission.replied" ||
      event.type === "form.replied" || event.type === "form.cancelled";
    if (!created && !settled) return;
    const id = kind === "permission"
      ? event.data[created ? "id" : "requestID"]
      : created && form && typeof form === "object"
      ? Reflect.get(form, "id")
      : event.data.id;
    if (typeof id !== "string") return;
    const key = `${kind}:${id}`,
      owner = typeof sid === "string" ? sid : this.#pending.get(key)?.sessionID;
    if (settled) {
      this.#settledPending.add(key);
      if (this.#settledPending.size > 4096) {
        this.#settledPending.delete(
          this.#settledPending.values().next().value!,
        );
      }
      this.#setPending(key);
    } else if (owner && !this.#settledPending.has(key)) {
      const directory = event.location?.directory ??
        (owner !== "global"
          ? this.#index.getMetadata(ids.encode(owner))?.directory
          : undefined);
      if (directory) {
        this.#setPending(key, { id, kind, sessionID: owner, directory });
      }
    }
    if (!owner || owner === "global") return;
    const current = this.#index.getMetadata(ids.encode(owner));
    if (current) {
      const counts = this.#pendingCounts.get(owner);
      this.#upsert({
        ...current,
        activityAuthority: counts?.stale
          ? "unknown"
          : this.#activityCurrent
          ? "current"
          : current.activityAuthority,
        attention: {
          ...current.attention,
          permissions: counts?.permissions ?? 0,
          questions: counts?.questions ?? 0,
        },
      });
    }
  }
  async #resync(
    client: V2Client,
    signal: AbortSignal,
    generation: number,
    reconnect = true,
  ): Promise<() => Promise<void>> {
    const active = await client.read(
      (api) => api.session.active({ signal }),
      signal,
    );
    await this.digest?.projects?.(generation, signal);
    const locations = await client.read(
      (api) => api.debug.location.list({ signal }),
      signal,
    );
    const pending = new Map<string, Pending>(
      [...this.#pending].map(([key, row]) =>
        [key, { ...row, stale: true }] as const
      ),
    );
    const projects = await this.digest?.projects?.(generation, signal);
    const owners = new Set([
      ...Object.keys(active),
      ...this.#running.keys(),
      ...[...pending.values()].filter((p) => p.sessionID !== "global").map((
        p,
      ) => p.sessionID),
      ...(this.#sink?.retainedSessions ?? []).filter((id) => ids.is(id)).map((
        id,
      ) => ids.decode(id)),
    ]);
    for (const location of locations) {
      const inventories = [
        [
          "permission",
          () =>
            client.read(
              (api) => api.permission.request.list({ location }, { signal }),
              signal,
            ),
        ],
        [
          "form",
          () =>
            client.read(
              (api) => api.form.list({ location }, { signal }),
              signal,
            ),
        ],
      ] as const;
      for (const [kind, read] of inventories) {
        try {
          const { data: rows } = await read();
          signal.throwIfAborted();
          // Each complete kind/location inventory owns only its own absence facts.
          for (const [key, value] of pending) {
            if (value.kind === kind && value.directory === location.directory) {
              pending.delete(key);
            }
          }
          for (const row of rows) {
            if (this.#settledPending.has(`${kind}:${row.id}`)) continue;
            pending.set(`${kind}:${row.id}`, {
              id: row.id,
              sessionID: row.sessionID,
              kind,
              directory: location.directory,
            });
            if (row.sessionID !== "global") owners.add(row.sessionID);
          }
        } catch (error) {
          signal.throwIfAborted();
          this.diagnostic(error);
        }
      }
    }
    const sessions: SessionFacts[] = [];
    const hydrated = new Set<string>();
    if (this.digest) {
      let keys = [...owners].map(ids.encode);
      while (keys.length) {
        const rows = await this.digest.read("opcv2.sessions", { ids: keys }, {
          owner: `resync:${generation}`,
          priority: "attention",
          signal,
        });
        keys.forEach((key) => hydrated.add(ids.decode(key)));
        keys = [];
        for (const row of rows) {
          sessions.push(row);
          if (row.parentID && !hydrated.has(row.parentID)) {
            keys.push(ids.encode(row.parentID));
          }
        }
      }
    }
    for (const id of owners) {
      if (hydrated.has(id)) continue;
      hydrated.add(id);
      try {
        const raw = await client.read(
          (api) => api.session.get({ sessionID: id }, { signal }),
          signal,
        );
        sessions.push(raw);
        if (raw.parentID && !hydrated.has(raw.parentID)) {
          owners.add(raw.parentID);
        }
      } catch (error) {
        signal.throwIfAborted();
        this.diagnostic(error);
      }
    }
    signal.throwIfAborted();
    const transcriptCommit = reconnect
      ? await this.transcript.resync(client, signal)
      : undefined;
    return async () => {
      signal.throwIfAborted();
      this.#generation = generation;
      this.#activityCurrent = true;
      this.#pending = pending;
      this.#pendingCounts.clear();
      for (const [key, row] of this.#pending) {
        if (this.#settledPending.has(key)) this.#pending.delete(key);
        else this.#countPending(row, 1);
      }
      if (reconnect) {
        await transcriptCommit?.();
      }
      this.#sink?.projectSeeds?.(projects?.projects ?? []);
      this.#sink?.projectAuthority?.("current");
      for (const raw of sessions) {
        const previous = this.#running.get(raw.id);
        if (active[raw.id]) {
          this.#running.set(
            raw.id,
            millis(raw.time.busy) || previous || Date.now(),
          );
        } else this.#running.delete(raw.id);
        const entry = this.#metadata(raw, !!active[raw.id]);
        const ended = previous !== undefined && !active[raw.id] &&
            millis(raw.time.idle) > previous
          ? millis(raw.time.idle)
          : undefined;
        // An old outcome cannot certify a lost newer execution's success.
        if (
          previous !== undefined && !active[raw.id] &&
          millis(raw.time.idle) <= previous
        ) {
          entry.attention.error =
            "Execution continuity was interrupted; its outcome is unknown.";
        }
        this.#execution(entry, ended);
      }
      for (const sid of [...this.#running.keys()]) {
        if (active[sid]) continue;
        this.#running.delete(sid);
        if (sessions.some((raw) => raw.id === sid)) continue;
        const previous = this.#index.getMetadata(ids.encode(sid));
        if (previous) {
          this.#upsert({
            ...previous,
            status: "idle",
            activityAuthority: "current",
            attention: {
              ...previous.attention,
              error:
                "Execution continuity was interrupted; its outcome is unknown.",
            },
          });
        }
      }
    };
  }
  async #refreshProjects(
    directories: readonly string[],
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    if (!this.digest?.projects) return;
    for (const directory of new Set(directories)) {
      const result = await this.digest.projects(
        generation,
        signal,
        undefined,
        directory,
      );
      signal.throwIfAborted();
      if (generation !== this.#generation) return;
      this.#sink?.projectSeeds?.(result.projects);
    }
  }
  async #event(
    event: V2Event,
    client: V2Client,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    this.catalogs?.event(event);
    const changedID = typeof event.data.sessionID === "string"
      ? ids.encode(event.data.sessionID)
      : undefined;
    if (changedID && event.type === "session.deleted") {
      await this.#deleted(
        changedID,
        this.#index.getMetadata(changedID),
        generation,
      );
      return;
    }
    if (
      changedID &&
      /^session\.tool\.(called|progress|success|failed)$/.test(event.type)
    ) {
      this.digest?.observe(generation, [{
        sessionID: changedID,
        revision: event.durable?.seq ?? event.created ?? Date.now(),
        reason: "helper",
        messages: typeof event.data.assistantMessageID === "string"
          ? [event.data.assistantMessageID]
          : undefined,
      }]);
    }
    if (
      changedID && event.data.sessionID !== "global" &&
      /^session\.(step\.|usage\.updated|compaction\.|inbox\.delivered|revert\.)/
        .test(event.type)
    ) {
      this.digest?.observe(generation, [{
        sessionID: changedID,
        revision: event.durable?.seq ?? event.created ?? Date.now(),
        reason: "messages",
        messages: typeof event.data.assistantMessageID === "string"
          ? [event.data.assistantMessageID]
          : undefined,
      }]);
    }
    await this.transcript.event(event);
    if (
      /^(project\.updated|worktree\.(updated|resolved)|location\.shutdown)$/
        .test(event.type)
    ) {
      const commit = await this.#resync(client, signal, generation, false);
      signal.throwIfAborted();
      await commit();
      return;
    }
    const form = event.data.form;
    const sid = event.data.sessionID ??
      (form && typeof form === "object"
        ? Reflect.get(form, "sessionID")
        : undefined);
    if (/^(permission\.|form\.)/.test(event.type)) {
      this.#pendingEvent(event, sid, form);
      const commit = await this.#resync(client, signal, generation, false);
      signal.throwIfAborted();
      await commit();
      return;
    }
    if (typeof sid !== "string" || sid === "global") return;
    if (
      !/^session\.execution\./.test(event.type) &&
      !/^session\.(created|forked|renamed|moved|metadata\.updated|archived|unarchived|deleted|retry\.scheduled|step\.started)$/
        .test(event.type)
    ) return;
    this.#lists.invalidate();
    this.digest?.observe(generation, [{
      sessionID: ids.encode(sid),
      revision: ++this.#observation,
      reason: "metadata",
    }]);
    if (event.type === "session.deleted") {
      const previous = this.#index.getMetadata(ids.encode(sid));
      this.#running.delete(sid);
      this.#finished.delete(ids.encode(sid));
      for (const [key, row] of this.#pending) {
        if (row.sessionID === sid) this.#setPending(key);
      }
      this.#sink?.indexRemove(ids.encode(sid));
      if (previous) {
        await this.#refreshProjects([previous.directory], signal, generation);
      }
      return;
    }
    const previousRun = this.#running.get(sid);
    if (event.type === "session.execution.started") {
      this.#running.set(sid, event.created ?? Date.now());
    }
    const previous = this.#index.getMetadata(ids.encode(sid));
    const raw = await client.read(
      (api) => api.session.get({ sessionID: sid }, { signal }),
      signal,
    );
    signal.throwIfAborted();
    if (generation !== this.#generation) return;
    // Retain the prior run as a mandatory resync key until metadata I/O settles.
    if (
      /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)
    ) this.#running.delete(sid);
    // An API snapshot may already cover a buffered execution edge. Native busy
    // and idle clocks prevent an older frame from reopening a completed run or
    // settling a newer one. Session.outcome alone is never continuity proof.
    const busy = millis(raw.time.busy), idle = millis(raw.time.idle);
    let ended: number | undefined;
    if (
      event.type === "session.execution.started" &&
      idle > (event.created ?? busy)
    ) {
      if (idle > 0) ended = idle;
      if (busy > idle) this.#running.set(sid, busy);
      else this.#running.delete(sid);
    }
    if (
      /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)
    ) {
      ended = event.created ??
        (previousRun !== undefined && idle > previousRun ? idle : undefined);
    }
    if (
      event.type !== "session.execution.started" &&
      busy > (event.created ?? 0) && busy > idle
    ) this.#running.set(sid, busy);
    const entry = this.#metadata(raw, this.#running.has(sid));
    if (
      event.type === "session.execution.started" ||
      event.type === "session.step.started" ||
      /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)
    ) delete entry.retry;
    if (
      event.type === "session.retry.scheduled" &&
      Number.isSafeInteger(event.data.attempt) &&
      typeof event.data.at === "number"
    ) {
      entry.retry = {
        attempt: Number(event.data.attempt),
        message: "Retrying execution.",
        next: event.data.at,
      };
    }
    if (event.type === "session.execution.failed" && !this.#running.has(sid)) {
      entry.attention.error = "Execution failed.";
    }
    this.#execution(
      entry,
      ended,
      previousRun !== undefined && event.type !== "session.execution.started" &&
        this.#index.getMetadata(entry.id)?.status === "idle",
    );
    if (/^session\.(created|forked|moved)$/.test(event.type)) {
      await this.#refreshProjects(
        [raw.location.directory, ...(previous ? [previous.directory] : [])],
        signal,
        generation,
      );
    }
    if (raw.parentID) {
      const pending = [raw.parentID], seen = new Set([sid]);
      for (const parent of pending) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        try {
          const raw = await client.read(
            (api) => api.session.get({ sessionID: parent }, { signal }),
            signal,
          );
          signal.throwIfAborted();
          this.#upsert(this.#metadata(raw, this.#running.has(parent)));
          if (raw.parentID) pending.push(raw.parentID);
        } catch (error) {
          if (!(error instanceof V2MissingSession)) throw error;
        }
      }
    }
  }
}
