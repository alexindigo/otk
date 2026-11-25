// SPDX-License-Identifier: LGPL-3.0-only
import { projectEditor } from "./project-edit.ts";
import { DeliveryBackfill, DeliveryJoin } from "@otk/harness";
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
  latestTerminal,
  OperationFailure,
  type PublicFailure,
  sessionErrorMessage,
  type TerminalEvidence,
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
import { errorText } from "./classify.ts";
import { revertSession, sessionActions } from "./session-actions.ts";
import { readSessionActivity } from "./recency.ts";
import { PendingAttentionIndex } from "./attention.ts";
import { commands } from "./commands.ts";
import { V2Pending } from "./pending.ts";
import { V2Prompt } from "./prompt.ts";
import { V2Shells } from "./shells.ts";
import { requestFailureRecord } from "./request-failure.ts";
import { EventRefresh } from "./event-refresh.ts";

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
type MetadataRefresh = {
  event: V2Event;
  execution?: V2Event;
  failure?: PublicFailure;
  retry?: V2Event;
  shellEnd?: number;
  projects?: boolean;
};
/** Managed-service connection, native identity and capability composition. */
export class OpencodeV2ServerAdapter implements Harness {
  storage(storage: import("@otk/harness").PluginStorage): void {
    this.transcript.requests.bind(storage);
  }
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
  #pendingAttention = new PendingAttentionIndex((id) =>
    this.#index.getMetadata(id)
  );
  #running = new Map<string, number>();
  #finished = new Map<string, TerminalEvidence>();
  #deliveries?: DeliveryBackfill;
  #deliveryJoin?: DeliveryJoin;
  #deliveryParents = new Set<string>();
  #version = "";
  #generation = 0;
  #lists = new V2SessionLists();
  #activityCurrent = false;
  #observation = 0;
  #helperListener?: () => void;
  #topologyListener?: () => void;
  #refresh?: EventRefresh;
  #metadataRefresh = new Map<string, MetadataRefresh>();
  #inventoryChanges?: Map<string, Pending | undefined>;
  #executionRevision = 0;
  #activeRead?: { revision: number; value: Promise<Record<string, unknown>> };
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
    dispatch?: (pressure: import("@otk/harness").EventDispatchPressure) => void,
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
          this.#refresh?.cancel();
          this.#metadataRefresh.clear();
          this.#activeRead = undefined;
          this.#activityCurrent = false;
          this.pending.uncertain();
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
        dispatch: dispatch
          ? (pressure) =>
            dispatch({ ...pressure, refresh: this.#refresh?.pressure })
          : undefined,
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
      recoveredFailure: (id, failure) => this.#errors.enrich(id, failure),
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
        // Fanout needs the server's ancestor route, not browser index credit.
        // The topology observer republishes from the pending owner on admission.
        if (this.#index.getMetadata(id)) this.#sink?.content(id, op);
        if (op.op === "permission.remove" || op.op === "form.remove") {
          this.#setPending(
            `${
              op.op === "permission.remove" ? "permission" : "form"
            }:${op.requestID}`,
          );
          this.#refreshAttention(id);
        }
      },
      // Inventory-first requests keep their facts for a later outcome.
      (sessionID, requestID, request) =>
        void this.#errors.retainHistory(
          sessionID,
          `observe:${requestID}`,
          () =>
            this.transcript.requests.observe({
              id: requestID,
              sessionID,
              request,
            }),
        ).catch((error) => this.diagnostic(error)),
    );
    this.prompts = new V2Prompt(
      () => this.stream.client,
      config.attachments,
      (id, operation) =>
        this.#shells.interrupt(this.stream.client, id, operation),
      (id, messageID, origin) =>
        this.transcript.submission(id, messageID, origin),
      this.transcript.reader,
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
      projectEdit: projectEditor(
        () => this.stream.client,
        () => this.catalogs?.catalogs.invalidateAll(["project"]),
      ),
      ...digestCapabilities,
      ...catalogCapabilities,
      source: {
        getSource: (id, ref, signal) =>
          this.transcript.source(
            id,
            ref,
            signal ?? new AbortController().signal,
          ),
      },
      prompt: {
        prompt: (input, operation) =>
          this.#action(
            input.sessionID,
            "prompt",
            operation,
            () => this.prompts.prompt(input, operation),
          ),
        abort: (id, operation) => this.prompts.abort(id, operation),
        withdraw: (id, messageID, operation) =>
          this.prompts.withdraw(id, messageID, operation),
      },
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
        this.#topologyListener = this.#index.observeTopology((id, parentID) => {
          for (const key of this.#pendingAttention.reparent({ id, parentID })) {
            const entry = this.#index.getMetadata(key);
            if (entry) this.#upsert(entry);
          }
          if (this.#index.getMetadata(id)) this.pending.publishOwner(id);
        });
        this.#sink = sink;
        if (digest) {
          this.#deliveryJoin = new DeliveryJoin(
            digest,
            (id, fact) => this.#applyDelivered(id, fact),
            this.diagnostic,
            config.digest?.publishrows,
          );
        }
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
        await this.#deliveries?.stop();
        this.#deliveries = undefined;
        await this.#deliveryJoin?.stop();
        this.#deliveryJoin = undefined;
        this.#deliveryParents.clear();
        this.#errors.reset();
        await this.catalogs?.stop();
        this.#helperListener?.();
        this.#helperListener = undefined;
        this.#topologyListener?.();
        this.#topologyListener = undefined;
        await this.stream.stop();
        await this.#refresh?.stop();
        await this.transcript.stop();
        await digest?.stop();
        await this.prompts.stop();
        this.#pending.clear();
        this.#pendingAttention.clear();
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
        if (input.retryRecovery) this.transcript.recovery.retry(id);
        await this.#errors.retryHistory(id);
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
      snapshotMessages: (id, input, signal) =>
        this.transcript.snapshot(id, input.before, signal, input.scope),
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
    const terminal = latestTerminal(
      this.#finished.get(entry.id),
      entry.activity,
    );
    if (terminal.terminal) this.#finished.set(entry.id, terminal);
    const reparented = this.#pendingAttention.reparent(entry);
    const pending = this.#pendingAttention.get(entry.id);
    const nativeID = ids.decode(entry.id), run = this.#running.get(nativeID);
    const runID = run === undefined ? undefined : `execution:${run}`;
    const startedAt = runID
      ? [entry, this.#index.getMetadata(entry.id)].map((row) =>
        row?.activity?.work?.items?.find((item) => item.id === runID)?.startedAt
      ).find((start) => start !== undefined)
      : undefined;
    entry = {
      ...entry,
      activity: {
        ...terminal,
        delivered: this.#delivered(entry),
        work: {
          keys: [
            ...(runID ? [runID] : []),
            ...this.#shells.keys(nativeID),
          ],
          fresh: this.#activityCurrent,
          items: [
            ...(runID
              ? [{
                id: runID,
                kind: "execution" as const,
                label: "Execution",
                title: entry.title,
                startedAt,
              }]
              : []),
            ...this.#shells.items(nativeID),
          ],
        },
        inputs: {
          keys: pending.inputs,
          fresh: this.#activityCurrent,
        },
        permissions: {
          keys: pending.permissions,
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
    this.#publishMetadata(entry);
    for (const id of reparented) {
      if (id === entry.id) continue;
      const ancestor = this.#index.getMetadata(id);
      if (ancestor) this.#upsert(ancestor);
    }
    const delivered = entry.activity?.delivered;
    if (
      entry.parentID && terminal.terminal &&
      (delivered?.terminal ?? 0) < terminal.terminal
    ) this.#deliveryJoin?.request([entry.id]);
    if (
      entry.parentID && terminal.terminal &&
      !this.#deliveryParents.has(entry.parentID)
    ) {
      this.#deliveryParents.add(entry.parentID);
      this.#deliveries?.request(entry.parentID);
    }
  }
  #publishMetadata(entry: SessionMetadata): void {
    if (!this.#sink) return;
    if (!this.#sink.index) this.#index.upsertMetadata(entry);
    this.#sink.indexUpsert(entry);
  }
  /** Delivery is the digest store's durable fact. A published entry carries
   * the last fact joined from that store; inventory rows never replace it. */
  #delivered(entry: SessionMetadata) {
    const published = this.#index.getMetadata(entry.id);
    return published
      ? published.activity?.delivered
      : entry.activity?.delivered;
  }
  #applyDelivered(
    id: string,
    fact: import("@otk/protocol").DeliveredEvidence | undefined,
  ): void {
    const entry = this.#index.getMetadata(id);
    if (
      !entry || JSON.stringify(entry.activity?.delivered) ===
        JSON.stringify(fact)
    ) return;
    this.#publishMetadata({
      ...entry,
      activity: {
        ...entry.activity,
        delivered: fact,
        terminalOrigin: "historical",
      },
    });
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
    kind: NonNullable<ErrorObservation["operation"]> | "prompt",
    operation: import("@otk/protocol").OperationContext | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const token = this.#errors.begin(
      id,
      kind === "prompt" ? undefined : kind,
      operation?.key.key,
    );
    try {
      return await run();
    } catch (cause) {
      const error =
        cause instanceof HarnessError && cause.code === "authentication"
          ? new OperationFailure("rejected", cause.code, cause, cause.facts)
          : cause;
      let retainedFailure: PublicFailure | undefined;
      if (
        this.#errors.accepts(id) && !operation?.signal.aborted &&
        error instanceof OperationFailure &&
        (error.outcome === "rejected" ||
          error.outcome === "unknown" && error.facts?.status !== undefined)
      ) {
        const failure = {
          code: error.code,
          retry: error.outcome === "rejected"
            ? "new-intent" as const
            : "none" as const,
          diagnosticID: error.diagnosticID,
          facts: {
            ...error.facts,
            action: `session.${kind}`,
            origin: operation?.key.origin,
            target: {
              sessionID: id,
              label: this.#index.getMetadata(id)?.title,
            },
            outcome: error.outcome,
          },
        };
        const message = requestFailureRecord(id, failure);
        await this.transcript.failure(message);
        const part = message.parts[0];
        if (part.kind === "external") retainedFailure = part.failure;
        if (error.facts && part.kind === "external") {
          error.facts.record = part.failure?.facts?.record;
          error.facts.origin = failure.facts.origin;
        }
      }
      // An actual HTTP rejection has independent HTTP provenance, not an
      // invented native execution event. Its observation borrows the retained
      // record's diagnostic and facts so every origin has a displayed pointer.
      if (
        !operation?.signal.aborted && this.#sink
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
          ...(retainedFailure
            ? { failure: retainedFailure }
            : error instanceof OperationFailure
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
    if (current && current.timeUpdated > row.timeUpdated) {
      row = {
        ...current,
        activity: {
          ...current.activity,
          ...latestTerminal(current.activity, row.activity),
        },
      };
    }
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
    if (ended) {
      this.#finished.set(
        entry.id,
        latestTerminal(
          this.#finished.get(entry.id),
          { terminal: ended },
          entry.activity,
        ),
      );
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
    await this.transcript.deleted(id);
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
    const mapped = metadata(raw);
    return {
      ...mapped,
      status: busy ? "busy" : "idle",
      activityAuthority: "current",
      activity: {
        ...mapped.activity,
        // The running token can be observation-time fallback. Only the native
        // busy clock establishes this run's start for elapsed presentation.
        work: {
          keys: [],
          fresh: false,
          items: this.#running.has(raw.id)
            ? [{
              id: `execution:${this.#running.get(raw.id)}`,
              kind: "execution",
              label: "Execution",
              title: mapped.title,
              startedAt: millis(raw.time.busy) || undefined,
            }]
            : [],
        },
      },
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
    this.#inventoryChanges?.set(key, row);
    this.#pendingAttention.set(
      key,
      row && row.sessionID !== "global"
        ? { ...row, sessionID: ids.encode(row.sessionID) }
        : undefined,
    );
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
    if (reconnect) {
      await this.#refresh?.stop();
      this.#metadataRefresh.clear();
      this.#activeRead = undefined;
      this.#refresh = new EventRefresh(
        signal,
        (error) => this.stream.reconnect(error),
      );
      await this.#deliveries?.stop();
      this.#deliveries = undefined;
      this.#deliveryParents.clear();
    }
    const changes = this.#inventoryChanges = new Map<
      string,
      Pending | undefined
    >();
    const protectedRequests = (kind: Pending["kind"]) =>
      new Set(
        [...changes.values()].filter((row) => row?.kind === kind).map((row) =>
          row!.id
        ),
      );
    const active = await client.read(
      (api) => api.session.active({ signal }),
      signal,
    );
    const historical: SessionMetadata[][] = [];
    await this.digest?.projects?.(generation, signal);
    const locations = await client.read(
      (api) => api.debug.location.list({ signal }),
      signal,
    );
    const previousShells = new Set(this.#shells.sessions());
    const shells = await this.#shells.snapshot(client, locations, signal);
    const directories = new Set(
      locations.map((location) => location.directory),
    );
    const pending = new Map<string, Pending>(
      [...this.#pending].filter(([, row]) => directories.has(row.directory))
        .map(([key, row]) => [key, { ...row, stale: true }] as const),
    );
    const projects = await this.digest?.projects?.(generation, signal);
    const inventories: (() => void)[] = [];
    const errors: { code: string; message: string }[] = [];
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
              this.pending.replacePermissions(
                location,
                permissions,
                protectedRequests("permission"),
              )
            );
          } else {
            const forms = rows as Parameters<V2Pending["replaceForms"]>[1];
            inventories.push(() =>
              this.pending.replaceForms(
                location,
                forms,
                protectedRequests("form"),
              )
            );
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
          errors.push({
            code: `inventory.${kind}`,
            message: kind === "permission"
              ? "Could not refresh pending permissions."
              : "Could not refresh pending forms.",
          });
        }
      }
    }
    // Subscribe first, then acquire live owners before durable endpoints. A shell
    // that ends before its owner snapshot is covered by this later history read;
    // one ending after that snapshot has an owned identity for buffered replay.
    if (reconnect && this.digest) {
      let after = "";
      for (;;) {
        let rows: SessionMetadata[];
        try {
          rows = await this.digest.read("supervision.terminals", { after }, {
            owner: `supervision:${generation}`,
            priority: "attention",
            signal,
          });
        } catch (error) {
          signal.throwIfAborted();
          this.diagnostic(error);
          break;
        }
        signal.throwIfAborted();
        if (!rows.length) break;
        historical.push(rows);
        for (const row of rows) {
          if (row.parentID) owners.add(ids.decode(row.parentID));
        }
        after = rows.at(-1)!.id;
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
      if (this.digest && !this.#deliveries) {
        this.#deliveries = new DeliveryBackfill(
          this.digest,
          (parent, updates, reset) => {
            if (generation !== this.#generation || !this.#sink) return;
            const dirty = new Set(updates.map((row) => row.id));
            if (reset) {
              for (const entry of this.#index.snapshotEntries()) {
                if (entry.parentID === parent) dirty.add(entry.id);
              }
            }
            this.#deliveryJoin?.request(dirty);
          },
          this.diagnostic,
        );
      }
      this.#activityCurrent = true;
      this.#shells.replace(shells);
      // An asynchronous inventory owns its captured absence, not newer live
      // requests. Explicit settlements retain the pending owner's tombstones.
      for (const [key, row] of changes) {
        if (row) {
          pending.set(key, row);
          directories.add(row.directory);
        } else pending.delete(key);
      }
      if (this.#inventoryChanges === changes) {
        this.#inventoryChanges = undefined;
      }
      const changedOwners = new Set(
        [...this.#pending.values(), ...pending.values()]
          .filter((row) => row.sessionID !== "global").map((row) =>
            ids.encode(row.sessionID)
          ),
      );
      this.pending.retainLocations(directories);
      this.pending.uncertain(protectedRequests("form"));
      this.#pending = pending;
      for (const [key, row] of this.#pending) {
        if (this.pending.settled(row.kind, row.id)) this.#pending.delete(key);
      }
      this.#pendingAttention.replace(
        [...this.#pending].filter(([, row]) => row.sessionID !== "global").map((
          [key, row],
        ) => [key, { ...row, sessionID: ids.encode(row.sessionID) }]),
      );
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
        // Lost ownership with no newer terminal is just absence of evidence.
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
          });
        }
      }
      for (const rows of historical) {
        signal.throwIfAborted();
        for (const row of rows) this.#merge(row);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      // Request ownership still changes when its session metadata read is
      // unavailable or its native location disappears from the loaded inventory.
      for (const id of changedOwners) this.#refreshAttention(id);
      for (const error of errors) this.#sink?.error?.(error);
    };
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
    if (
      this.#inventoryChanges &&
      /^(session\.(execution\.|shell\.|created$|forked$|moved$|deleted$|renamed$|metadata\.updated$|archived$|unarchived$)|shell\.)/
        .test(event.type)
    ) {
      this.#queueInventory(client, signal, generation);
    }
    if (changedID && generation === this.#generation) {
      if (
        /^session\.(tool\.(success|failed)|inbox\.delivered|revert\.)/.test(
          event.type,
        )
      ) this.#deliveries?.request(changedID, true);
      if (
        /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)
      ) {
        const parent = this.#index.getMetadata(changedID)?.parentID;
        if (parent) this.#deliveries?.request(parent, true);
      }
    }
    if (changedID && event.type === "session.deleted") {
      this.#refresh?.forget(`session:${event.data.sessionID}`);
      this.#metadataRefresh.delete(event.data.sessionID as string);
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
        this.#queueProjects([previous.directory], signal, generation);
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
      /^session\.(step\.|tool\.(called|success|failed)$|usage\.updated|compaction\.|inbox\.delivered|revert\.)/
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
    if (
      event.type === "session.execution.failed" &&
      typeof event.data.sessionID === "string" &&
      !this.#errors.accepts(ids.encode(event.data.sessionID))
    ) return;
    const pendingForm = event.data.form;
    const pendingSession = event.data.sessionID ??
      (pendingForm && typeof pendingForm === "object"
        ? Reflect.get(pendingForm, "sessionID")
        : undefined);
    if (/^(permission\.|form\.)/.test(event.type)) {
      this.#pendingEvent(event, pendingSession, pendingForm);
    }
    const executionFailure = await this.transcript.executionFailure(
      event,
      typeof event.data.sessionID === "string"
        ? this.#index.getMetadata(ids.encode(event.data.sessionID))?.title
        : undefined,
      signal,
    );
    signal.throwIfAborted();
    if (generation !== this.#generation) return;
    const requestOwner = changedID ??
      (typeof pendingSession === "string" && pendingSession !== "global"
        ? ids.encode(pendingSession)
        : undefined);
    if (/^(permission\.|form\.)/.test(event.type) && requestOwner) {
      const identity = String(
        event.data.requestID ?? event.data.id ??
          (event.data.form && typeof event.data.form === "object"
            ? Reflect.get(event.data.form, "id")
            : ""),
      );
      await this.#errors.retainHistory(
        requestOwner,
        `${event.type}:${identity}`,
        () => this.transcript.event(event),
      );
    } else await this.transcript.event(event);
    const shell = this.#shells.event(event);
    if (shell) {
      this.#queueMetadata(
        { ...event, data: { ...event.data, sessionID: shell.sessionID } },
        client,
        signal,
        generation,
        executionFailure,
        shell.ended,
      );
      return;
    }
    if (
      /^(project\.updated|worktree\.(updated|resolved)|location\.shutdown)$/
        .test(event.type)
    ) {
      this.#queueInventory(client, signal, generation);
      return;
    }
    const form = event.data.form;
    const sid = event.data.sessionID ??
      (form && typeof form === "object"
        ? Reflect.get(form, "sessionID")
        : undefined);
    if (/^(permission\.|form\.)/.test(event.type)) {
      // The event already supplied the changed request and settlement identity.
      // Only a new owner needs keyed scalar hydration, never global inventories.
      if (
        typeof sid === "string" && sid !== "global" &&
        !this.#index.getMetadata(ids.encode(sid))
      ) {
        this.#queueMetadata(
          { type: "session.metadata.updated", data: { sessionID: sid } },
          client,
          signal,
          generation,
        );
      }
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
    this.#queueMetadata(event, client, signal, generation, executionFailure);
  }
  #queueProjects(
    directories: readonly string[],
    signal: AbortSignal,
    generation: number,
  ): void {
    for (const directory of new Set(directories)) {
      this.#refresh?.request(`project:${directory}`, async (current) => {
        if (!this.digest?.projects) return;
        const result = await this.digest.projects(
          generation,
          signal,
          undefined,
          directory,
        );
        if (current() && generation === this.#generation) {
          this.#sink?.projectSeeds?.(result.projects);
        }
      });
    }
  }
  #queueInventory(
    client: V2Client,
    signal: AbortSignal,
    generation: number,
  ): void {
    this.#refresh?.request("inventory", async (current) => {
      const commit = await this.#resync(client, signal, generation, false);
      if (current() && generation === this.#generation) await commit();
    });
  }
  #queueMetadata(
    event: V2Event,
    client: V2Client,
    signal: AbortSignal,
    generation: number,
    failure?: PublicFailure,
    shellEnd?: number,
  ): void {
    const sid = event.data.sessionID as string;
    const previous = this.#metadataRefresh.get(sid);
    const execution = /^session\.execution\./.test(event.type);
    if (execution) this.#executionRevision++;
    const value: MetadataRefresh = {
      ...previous,
      event,
      ...(execution ? { execution: event, failure } : {}),
      ...(/^session\.(execution\.|step\.started|retry\.scheduled)/.test(
          event.type,
        )
        ? { retry: event }
        : {}),
      ...(shellEnd ? { shellEnd } : {}),
      projects: previous?.projects ||
        /^session\.(created|forked|moved)$/.test(event.type),
    };
    this.#metadataRefresh.set(sid, value);
    this.#refresh?.request(`session:${sid}`, async (current) => {
      try {
        await this.#refreshMetadata(value, client, signal, generation, current);
      } catch (error) {
        if (!(error instanceof V2MissingSession)) throw error;
      } finally {
        if (this.#metadataRefresh.get(sid) === value) {
          this.#metadataRefresh.delete(sid);
        }
      }
    });
  }
  #readActive(
    client: V2Client,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (this.#activeRead?.revision !== this.#executionRevision) {
      this.#activeRead = {
        revision: this.#executionRevision,
        value: client.read((api) => api.session.active({ signal }), signal),
      };
    }
    return this.#activeRead.value;
  }
  async #refreshMetadata(
    value: MetadataRefresh,
    client: V2Client,
    signal: AbortSignal,
    generation: number,
    current: () => boolean,
  ): Promise<void> {
    const event = value.execution ?? value.event;
    const sid = event.data.sessionID as string;
    const previousRun = this.#running.get(sid);
    const executionFailure = value.failure;
    this.#errors.register(ids.encode(sid));
    const previous = this.#index.getMetadata(ids.encode(sid));
    const raw = await client.read(
      (api) => api.session.get({ sessionID: sid }, { signal }),
      signal,
    );
    signal.throwIfAborted();
    if (!current() || generation !== this.#generation) return;
    // Buffered events and metadata clocks are not process ownership. Read the
    // same native owner used at bootstrap, so a delayed edge cannot revive a
    // dead run or retire a newer run. Keep its resync identity until I/O settles.
    if (/^session\.execution\./.test(event.type)) {
      const active = await this.#readActive(client, signal);
      signal.throwIfAborted();
      if (!current() || generation !== this.#generation) return;
      const terminalEvent =
        /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type);
      const newer = millis(raw.time.busy) >
        Math.max(event.created ?? 0, millis(raw.time.idle));
      if (active[sid] && (!terminalEvent || newer)) {
        this.#running.set(
          sid,
          millis(raw.time.busy) || previousRun || event.created || Date.now(),
        );
      } else this.#running.delete(sid);
    }
    if (
      event.type === "session.execution.started" && this.#running.has(sid) &&
      this.#errors.snapshot(ids.encode(sid)).observations.length
    ) this.#errors.clear(ids.encode(sid));
    // Native shutdown deliberately does not advance idle. Its interrupted event
    // is continuity loss, not a finish; only the durable outcome/idle pair counts.
    const ended = metadata(raw).activity?.terminal;
    const activityEvent = /^(session\.(execution\.|step\.|shell\.)|shell\.)/
      .test(
        value.event.type,
      );
    const entry = this.#metadata({
      ...raw,
      activity: Math.max(
        previous?.timeUpdated ?? 0,
        activityEvent ? value.event.created ?? 0 : 0,
      ),
      terminal: value.shellEnd,
    }, this.#running.has(sid));
    if (
      previous?.activity?.terminal === entry.activity?.terminal &&
      previous?.activity?.outcome === entry.activity?.outcome
    ) {
      entry.activity = {
        ...entry.activity,
        ...(previous?.activity?.terminalFailure
          ? { terminalFailure: previous.activity.terminalFailure }
          : {}),
        ...(previous?.activity?.terminalOrigin
          ? { terminalOrigin: previous.activity.terminalOrigin }
          : {}),
      };
    }
    if (value.shellEnd && entry.activity?.terminal === value.shellEnd) {
      entry.activity = { ...entry.activity, terminalOrigin: "live" };
    }
    if (
      /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type) &&
      event.data.reason !== "shutdown" &&
      (event.created === undefined || event.created === ended) &&
      event.type === `session.execution.${entry.activity?.outcome}` &&
      entry.activity?.terminal === ended && ended
    ) {
      entry.activity = {
        ...entry.activity,
        terminalOrigin: "live",
        ...(executionFailure ? { terminalFailure: executionFailure } : {}),
      };
    }
    if (
      value.retry && value.retry.type !== "session.retry.scheduled"
    ) delete entry.retry;
    if (
      value.retry?.type === "session.retry.scheduled" &&
      Number.isSafeInteger(value.retry.data.attempt) &&
      typeof value.retry.data.at === "number"
    ) {
      entry.retry = {
        attempt: Number(value.retry.data.attempt),
        message: errorText(value.retry.data.error),
        next: value.retry.data.at,
      };
    }
    if (
      event.type === "session.execution.failed" && !this.#running.has(sid) &&
      (event.created === undefined || event.created === ended) &&
      raw.outcome === "failed"
    ) {
      const error = event.data.error;
      this.#errors.native(ids.encode(sid), {
        ...(executionFailure ? { failure: executionFailure } : {}),
        message: executionFailure?.facts?.reason ??
          (error && typeof error === "object" &&
              typeof Reflect.get(error, "message") === "string"
            ? String(Reflect.get(error, "message"))
            : "Execution failed."),
      }, event.id);
    }
    if (
      event.type === "session.execution.interrupted" &&
      event.data.reason !== "shutdown" && !this.#running.has(sid) &&
      (event.created === undefined || event.created === ended) &&
      raw.outcome === "interrupted"
    ) {
      this.#errors.native(ids.encode(sid), {
        message: "Execution interrupted.",
        kind: "MessageAbortedError",
      }, event.id);
    }
    this.#execution(
      entry,
      ended ?? value.shellEnd,
      previousRun !== undefined && event.type !== "session.execution.started" &&
        this.#index.getMetadata(entry.id)?.status === "idle",
    );
    if (value.projects) {
      this.#queueProjects(
        [raw.location.directory, ...(previous ? [previous.directory] : [])],
        signal,
        generation,
      );
    }
    if (raw.parentID && !this.#index.getMetadata(ids.encode(raw.parentID))) {
      this.#queueMetadata(
        { type: "session.metadata.updated", data: { sessionID: raw.parentID } },
        client,
        signal,
        generation,
      );
    }
  }
}
