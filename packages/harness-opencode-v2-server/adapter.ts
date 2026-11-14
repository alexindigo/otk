// SPDX-License-Identifier: LGPL-3.0-only
import {
  type DigestPolicy,
  type DigestPort,
  type Harness,
  type HarnessCore,
  HarnessError,
  type HarnessSink,
  type ProviderReadPort,
  SessionErrors,
  SessionIndex,
} from "@otk/harness";
import type {
  Capabilities,
  ContentSession,
  SessionMetadata,
} from "@otk/protocol";
import {
  type ErrorObservation,
  OperationFailure,
  sessionErrorMessage,
} from "@otk/protocol";
import { type DiscoveredService, discoverV2 } from "./discovery.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { type V2Event, V2Stream } from "./stream.ts";
import { type V2Client, V2HttpFailure, V2MissingSession } from "./client.ts";
import { metadata, millis, session, type SessionFacts } from "./metadata.ts";
import { V2SessionLists } from "./session-lists.ts";
import { V2Catalogs } from "./catalogs.ts";
import { mapAgents } from "./catalog-readers.ts";
import { Transcript } from "./transcript.ts";
import { revertSession, sessionActions } from "./session-actions.ts";
import { readSessionActivity } from "./recency.ts";
import { pendingAttention } from "./attention.ts";
import { commands } from "./commands.ts";
import { V2Pending } from "./pending.ts";
import { V2Prompt } from "./prompt.ts";
import { V2Shells } from "./shells.ts";

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
/** Managed-service connection, native identity and capability composition. */
export class OpencodeV2ServerAdapter implements Harness {
  readonly core: HarnessCore;
  readonly capabilities: Readonly<Capabilities>;
  readonly digest?: DigestPort;
  readonly catalogs?: V2Catalogs;
  readonly stream: V2Stream;
  readonly transcript: Transcript;
  readonly pending: V2Pending;
  readonly prompts: V2Prompt;
  readonly #shells = new V2Shells();
  #sink?: HarnessSink;
  #index = new SessionIndex();
  #pending = new Map<string, Pending>();
  #running = new Map<string, number>();
  #finished = new Map<string, number>();
  #version = "";
  #generation = 0;
  #lists = new V2SessionLists();
  #activityCurrent = false;
  #observation = 0;
  #helperListener?: () => void;
  #errors = new SessionErrors(
    (id, state) => {
      const entry = this.#index.getMetadata(id);
      if (entry) this.#upsert(entry, state);
      if (this.transcript.buffers.subscribed(id)) {
        this.transcript.error(id, state);
      }
    },
    (id) =>
      !!this.#sink &&
      (!!this.#index.getMetadata(id) || this.transcript.buffers.subscribed(id)),
    (id) =>
      this.#sink
        ? this.#index.getMetadata(id)?.attention.errorState
        : undefined,
  );
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
      agents: (directory, signal) =>
        this.catalogs
          ? this.catalogs.catalogs.get(directory, "agents", signal)
          : this.stream.client.read(
            (api) => api.agent.list({ location: { directory } }, { signal }),
            signal,
          ).then((result) => mapAgents(result.data)),
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
    this.pending = new V2Pending(
      () => this.stream.client,
      (id) => this.#index.getMetadata(id),
      (id, op) => {
        this.#sink?.content(id, op);
        if (op.op === "permission.remove" || op.op === "form.remove") {
          this.#setPending(
            `${
              op.op === "permission.remove" ? "permission" : "form"
            }:${op.requestID}`,
          );
          this.#refreshAttention(id);
        }
      },
    );
    this.prompts = new V2Prompt(
      () => this.stream.client,
      config.attachments,
      (id, operation) =>
        this.#shells.interrupt(this.stream.client, id, operation),
    );
    const catalogCapabilities: Capabilities = this.catalogs
      ? {
        agents: this.catalogs.agents,
        models: this.catalogs.models,
        files: this.catalogs.files,
        catalogs: {
          watch: (directory, listener, signal) =>
            this.catalogs!.watch(directory, listener, signal),
          demand: (directory, demand, signal) =>
            this.catalogs!.demand(directory, demand, signal),
          refresh: (directory, signal, kinds) =>
            this.catalogs!.refresh(directory, signal, kinds),
        },
        ...(this.catalogs.history ? { history: this.catalogs.history } : {}),
        // Catalog metadata remains available. V2 cannot materialize MCP URI inputs.
      }
      : {};
    const capabilities: Capabilities = {
      ...digestCapabilities,
      ...catalogCapabilities,
      prompt: this.prompts,
      permissions: this.pending.permissions,
      forms: this.pending.forms,
      questions: this.pending.questions,
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
          // Metadata actions publish terminal facts, never execution ownership.
          this.#upsert(this.#metadata(raw, this.#running.has(raw.id)));
        },
        removed: async (id, operation) => {
          const client = this.stream.client;
          const native = ids.decode(id);
          // Preserve last-known metadata without blocking a lifetime mutation
          // behind unrelated finite reads (for example a delayed seen lookup).
          const metadata = this.#index.getMetadata(id) ?? this.#metadata(
            await client.read(
              (api) =>
                api.session.get({ sessionID: native }, {
                  signal: operation?.signal,
                }),
              operation?.signal,
            ),
            this.#running.has(native),
          );
          const intent = crypto.randomUUID(), generation = this.#generation;
          await digest?.deleteIntent(id, intent, "begin", generation);
          try {
            await client.effect(
              (api) => api.session.remove({ sessionID: native }),
              operation,
            );
            await digest?.deleteIntent(id, intent, "confirmed", generation);
            await this.#deleted(
              id,
              metadata,
              generation,
            );
          } catch (error) {
            await digest?.deleteIntent(id, intent, "failed", generation);
            throw error;
          }
        },
      }),
    };
    // Session command diagnostics share one owner with native execution events.
    // Wrapping the capability lifetime keeps independent HTTP and event provenance.
    if (capabilities.shell) {
      const shell = capabilities.shell;
      capabilities.shell = {
        shell: (input, operation) =>
          this.#action(
            input.sessionID,
            "shell",
            operation,
            () => shell.shell(input, operation),
          ),
      };
    }
    if (capabilities.commands) {
      const commands = capabilities.commands;
      capabilities.commands = {
        ...commands,
        command: (input, operation) =>
          this.#action(
            input.sessionID,
            "command",
            operation,
            () => commands.command(input, operation),
          ),
      };
    }
    if (capabilities.sessionActions) {
      const actions = capabilities.sessionActions;
      capabilities.sessionActions = {
        ...actions,
        compact: (id, model, operation) =>
          this.#action(
            id,
            "compact",
            operation,
            () => actions.compact(id, model, operation),
          ),
      };
    }
    this.capabilities = Object.freeze(capabilities);
    const version = () => this.#version;
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
        this.#errors.reset();
        await this.catalogs?.stop();
        this.#helperListener?.();
        this.#helperListener = undefined;
        await this.stream.stop();
        await this.transcript.stop();
        await digest?.stop();
        await this.prompts.stop();
        this.#pending.clear();
        this.pending.clear();
        this.#running.clear();
        this.#shells.clear();
        this.#finished.clear();
      },
      subscriptions: (id, count) => {
        this.transcript.subscriptions(id, count);
        if (!count) this.#errors.release(id);
      },
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
        const raw = await readSessionActivity(
          this.stream.client,
          native,
          signal,
        );
        this.transcript.observe(raw);
        return this.#sessionErrors(
          await revertSession(this.stream.client, raw, signal),
        );
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
            result.push(this.#sessionErrors(session(raw)));
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
      listMessages: async (id, input, signal) => {
        const decorate = (page: import("@otk/protocol").MessagePage) => ({
          ...page,
          ...(page.session
            ? { session: this.#sessionErrors(page.session) }
            : {}),
        });
        return decorate(
          await this.transcript.page(
            id,
            input?.before,
            signal,
            input?.publish
              ? (page) => input.publish!(decorate(page))
              : undefined,
          ),
        );
      },
      createSession: async (input, operation) => {
        const client = this.stream.client;
        const parentID = input.parentID === undefined
          ? undefined
          : ids.decode(input.parentID);
        if (parentID !== undefined) {
          const parent = await client.read(
            (api) =>
              api.session.get({ sessionID: parentID }, {
                signal: operation?.signal,
              }),
            operation?.signal,
          );
          if (parent.location.directory !== input.directory) {
            throw new HarnessError(
              "params",
              "Child session directory must match its parent",
            );
          }
        }
        const raw = await client.effect(
          (api) =>
            api.session.create({
              ...(parentID === undefined
                ? { location: { directory: input.directory } }
                : { parentID }),
              ...(input.title === undefined ? {} : { title: input.title }),
            }),
          operation,
        );
        this.transcript.observe(raw);
        this.#merge(metadata(raw));
        return session(raw);
      },
    };
  }
  #upsert(
    entry: SessionMetadata,
    errors = this.#errors.snapshot(entry.id),
  ): void {
    if (!this.#sink) return;
    const pending = pendingAttention(
      entry.id,
      [...this.#pending.values()].filter((row) => row.sessionID !== "global")
        .map((row) => ({ ...row, sessionID: ids.encode(row.sessionID) })),
      (id) => id === entry.id ? entry : this.#index.getMetadata(id),
    );
    entry = {
      ...entry,
      activity: {
        terminal: Math.max(
          entry.activity?.terminal ?? 0,
          this.#finished.get(entry.id) ?? 0,
        ),
        work: {
          keys: [
            ...(this.#running.has(ids.decode(entry.id))
              ? [`execution:${this.#running.get(ids.decode(entry.id))}`]
              : []),
            ...this.#shells.keys(ids.decode(entry.id)),
          ],
          fresh: this.#activityCurrent,
        },
        inputs: {
          keys: [...this.#pending.values()].filter((row) =>
            !row.stale && row.sessionID !== "global" &&
            row.kind !== "permission" && ids.encode(row.sessionID) === entry.id
          ).map((row) => row.id),
          fresh: this.#activityCurrent,
        },
        permissions: {
          keys: [...this.#pending.values()].filter((row) =>
            !row.stale && row.sessionID !== "global" &&
            row.kind === "permission" && ids.encode(row.sessionID) === entry.id
          ).map((row) => row.id),
          fresh: this.#activityCurrent,
        },
      },
      attention: {
        ...entry.attention,
        ...pending.attention,
        errorState: errors,
        error: sessionErrorMessage(errors),
      },
      ...(pending.stale ? { activityAuthority: "unknown" } : {}),
    };
    if (!this.#sink.index) this.#index.upsertMetadata(entry);
    this.#sink.indexUpsert(entry);
  }
  #refreshAttention(id: string): void {
    for (const key of [id, ...this.#index.ancestors(id)]) {
      const entry = this.#index.getMetadata(key);
      if (entry) this.#upsert(entry);
    }
  }
  #sessionErrors(value: ContentSession): ContentSession {
    const errorState = this.#errors.snapshot(value.id);
    return { ...value, errorState, error: sessionErrorMessage(errorState) };
  }
  async #action<T>(
    id: string,
    kind: NonNullable<ErrorObservation["operation"]>,
    operation: import("@otk/protocol").OperationContext | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const token = this.#errors.begin(id, kind, operation?.key.key);
    try {
      return await run();
    } catch (error) {
      // Definitive input rejection belongs to the requesting operation, not the
      // session's execution history. Native events and uncertain HTTP outcomes
      // retain their independent session diagnostics.
      if (
        !operation?.signal.aborted && this.#sink &&
        !(error instanceof OperationFailure && error.outcome === "rejected")
      ) {
        let cause: unknown = error;
        const seen = new Set<unknown>();
        while (
          cause && typeof cause === "object" && !seen.has(cause) &&
          !(cause instanceof V2HttpFailure)
        ) {
          seen.add(cause);
          cause = Reflect.get(cause, "cause");
        }
        this.#errors.http(token, {
          ...(cause instanceof V2HttpFailure
            ? { ...cause.detail, status: cause.status }
            : {
              message: error instanceof Error ? error.message : String(error),
            }),
          ...(error instanceof OperationFailure
            ? {
              failure: {
                code: error.code,
                retry: error.outcome === "unknown"
                  ? "none" as const
                  : error.outcome === "unavailable"
                  ? "same-intent" as const
                  : "new-intent" as const,
                diagnosticID: crypto.randomUUID(),
              },
            }
            : {}),
        });
      }
      throw error;
    } finally {
      this.#errors.settled(token);
    }
  }
  #merge(row: SessionMetadata): void {
    const current = this.#index.getMetadata(row.id);
    if (current && current.timeUpdated > row.timeUpdated) row = { ...current };
    const native = ids.decode(row.id);
    this.#upsert({
      ...row,
      status: this.#running.has(native) || this.#shells.busy(native)
        ? "busy"
        : this.#activityCurrent
        ? "idle"
        : current?.status ?? row.status,
      retry: current?.retry,
      attention: {
        ...(current?.attention ?? row.attention),
      },
      activityAuthority: this.#activityCurrent
        ? "current"
        : current?.activityAuthority ?? "unknown",
    });
  }
  #execution(
    entry: SessionMetadata,
    ended?: number,
    _alreadyObserved = false,
  ): void {
    if (ended && ended > (this.#finished.get(entry.id) ?? 0)) {
      this.#finished.set(entry.id, ended);
    }
    this.#upsert(entry);
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
        const raw = await readSessionActivity(
          this.stream.client,
          ids.decode(key),
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
    this.#errors.remove(id);
    this.transcript.release(id);
    this.#shells.retire(ids.decode(id));
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
  }
  #metadata(raw: SessionFacts, busy: boolean): SessionMetadata {
    busy ||= this.#shells.busy(raw.id);
    const mapped = session(raw);
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
      activityAuthority: "current",
      activity: metadata(raw).activity,
      ...(busy && this.#index.getMetadata(mapped.id)?.retry
        ? { retry: this.#index.getMetadata(mapped.id)!.retry }
        : {}),
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
        ...(!busy && raw.outcome === "failed"
          ? { error: "Execution failed." }
          : {}),
      },
    };
  }
  #setPending(key: string, row?: Pending): void {
    if (row) this.#pending.set(key, row);
    else this.#pending.delete(key);
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
      if (owner) this.pending.settle(kind, id, owner);
      this.#setPending(key);
    } else if (owner && !this.pending.settled(kind, id)) {
      const directory = event.location?.directory ??
        (owner !== "global"
          ? this.#index.getMetadata(ids.encode(owner))?.directory
          : undefined);
      if (directory) {
        const accepted = kind === "permission"
          ? this.pending.acceptPermission({ directory }, event.data)
          : this.pending.acceptForm({ directory }, form);
        if (!accepted) return;
        this.#setPending(key, { id, kind, sessionID: owner, directory });
      }
    }
    if (!owner || owner === "global") return;
    this.#refreshAttention(ids.encode(owner));
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
    const previousShells = new Set(this.#shells.sessions());
    const shells = await this.#shells.snapshot(client, locations, signal);
    const pending = new Map<string, Pending>(
      [...this.#pending].map(([key, row]) =>
        [key, { ...row, stale: true }] as const
      ),
    );
    const projects = await this.digest?.projects?.(generation, signal);
    const inventories: (() => void)[] = [];
    const owners = new Set([
      ...Object.keys(active),
      ...this.#running.keys(),
      ...previousShells,
      ...shells.map((shell) => shell.sessionID),
      ...[...pending.values()].filter((p) => p.sessionID !== "global").map((
        p,
      ) => p.sessionID),
      ...(this.#sink?.retainedSessions ?? []).filter((id) => ids.is(id)).map((
        id,
      ) => ids.decode(id)),
    ]);
    for (const location of locations) {
      const readers = [
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
      for (const [kind, read] of readers) {
        try {
          const { data: rows } = await read();
          signal.throwIfAborted();
          if (kind === "permission") {
            const permissions = rows as Parameters<
              V2Pending["replacePermissions"]
            >[1];
            inventories.push(() =>
              this.pending.replacePermissions(location, permissions)
            );
          } else {
            const forms = rows as Parameters<V2Pending["replaceForms"]>[1];
            inventories.push(() => this.pending.replaceForms(location, forms));
          }
          // Each complete kind/location inventory owns only its own absence facts.
          for (const [key, value] of pending) {
            if (value.kind === kind && value.directory === location.directory) {
              pending.delete(key);
            }
          }
          for (const row of rows) {
            if (this.pending.settled(kind, row.id)) continue;
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
        const raw = await readSessionActivity(client, id, signal);
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
      this.#shells.replace(shells);
      this.#pending = pending;
      for (const [key, row] of this.#pending) {
        if (this.pending.settled(row.kind, row.id)) this.#pending.delete(key);
      }
      for (const apply of inventories) apply();
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
      this.pending.retireSession(event.data.sessionID as string);
      const previous = this.#index.getMetadata(changedID);
      await this.#deleted(
        changedID,
        previous,
        generation,
      );
      // Population refresh belongs to the event stream, not the confirmed
      // mutation's receipt. A held read cannot delay deletion confirmation.
      if (previous) {
        await this.#refreshProjects([previous.directory], signal, generation);
      }
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
    const shell = this.#shells.event(event);
    if (shell) {
      const raw = await readSessionActivity(client, shell.sessionID, signal);
      signal.throwIfAborted();
      if (generation !== this.#generation) return;
      const entry = this.#metadata(raw, this.#running.has(raw.id));
      this.#execution(entry, entry.status === "idle" ? shell.ended : undefined);
      if (raw.parentID) await this.#hydrate([ids.encode(raw.parentID)], signal);
      return;
    }
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
      this.#errors.remove(ids.encode(sid));
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
    this.#errors.register(ids.encode(sid));
    if (event.type === "session.execution.started") {
      this.#running.set(sid, event.created ?? Date.now());
      // A busy edge only clears an existing diagnostic. Publishing an empty
      // error transition for every healthy run needlessly invalidates content.
      if (this.#errors.snapshot(ids.encode(sid)).observations.length) {
        this.#errors.clear(ids.encode(sid));
      }
    }
    const previous = this.#index.getMetadata(ids.encode(sid));
    const raw = await readSessionActivity(client, sid, signal);
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
      const error = event.data.error;
      this.#errors.native(ids.encode(sid), {
        message: error && typeof error === "object" &&
            typeof Reflect.get(error, "message") === "string"
          ? String(Reflect.get(error, "message"))
          : "Execution failed.",
      }, event.id);
    }
    if (
      event.type === "session.execution.interrupted" && !this.#running.has(sid)
    ) {
      this.#errors.native(ids.encode(sid), {
        message: "Execution interrupted.",
        kind: "MessageAbortedError",
      }, event.id);
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
