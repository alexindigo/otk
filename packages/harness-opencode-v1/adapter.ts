// SPDX-License-Identifier: LGPL-3.0-only
import { projectEditor } from "./project-edit.ts";
import { DeliveryBackfill, DeliveryJoin } from "@otk/harness";
import {
  type DiagnosticSink,
  errorMessage,
  isAssistantTerminal,
  isAttentionOp,
  isCancellation,
  latestTerminal,
  normalizeError,
  OperationFailure,
  sourceAt,
  type TerminalEvidence,
} from "@otk/protocol";
import type { ContentOp, Part, RevertInfo, Todo } from "@otk/protocol";
import type { SessionMetadata as IndexEntry } from "@otk/protocol";
import { harnessDb, type OpencodeV1AdapterConfig } from "./config.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { parseDiff, StreamBuffers } from "@otk/content";
import {
  type Capabilities,
  CapabilityRegistry,
  ContentReplay,
  type DigestPort,
  type Harness,
  type HarnessCore,
  HarnessError,
  type HarnessSink,
  SessionIndex,
} from "@otk/harness";
import { Client, HttpFailure, NativeRequestFailure } from "./client.ts";
import { type ErrorRequest, SessionErrors } from "./errors.ts";
import { FailureAttempts } from "./failure-attempts.ts";
import { sessionErrorMessage, type SessionErrorState } from "@otk/protocol";
import { BootstrapDb } from "./db.ts";
import { terminalFacts, terminalToken } from "./db-hints.ts";
import { History } from "./history.ts";
import { consumeEvents } from "./events.ts";
import {
  assistantSettled,
  deriveMessage,
  mapDiffs,
  mapIndex,
  mapMessage,
  mapPart,
  mapSession,
  mapStreamingShell,
  referencePart,
} from "./map.ts";
import { MessageClocks } from "./message-clocks.ts";
import {
  eventRecord,
  isPromptPart,
  parseSourceRef,
  RecordProjection,
  recordReference,
  sourceFailure,
} from "./records.ts";
import { V1RecordRetention } from "./record-retention.ts";
import { requestFailureRecord } from "./request-failure.ts";
import { SelectionIntents } from "./selection-intent.ts";
import { messageOutput } from "./message-clock.ts";
import { mapPermission } from "./map.ts";
import type {
  Envelope,
  Info,
  RawDiff,
  RawPart,
  RawPermission,
  RawQuestion,
  Session,
} from "./types.ts";
import { Backoff, Watchdog } from "./watchdog.ts";
import { TaskProgress } from "./tasks.ts";
import { prompt } from "./prompt.ts";
import { files } from "./files.ts";
import { mapQuestion, questions } from "./questions.ts";
import { sessions } from "./sessions.ts";
import { AgentColors, agents } from "./agents.ts";
import { models } from "./models.ts";
import { usage } from "./usage.ts";
import { resources } from "./resources.ts";
import { commands } from "./commands.ts";
import { type Launch, shell } from "./shell.ts";
import { type PendingPermission, permissions } from "./permissions.ts";
import { restore, revert } from "./revert.ts";
import { historyEntry } from "./history.ts";
import { sessionActions } from "./session-actions.ts";
import { sessionDirectory } from "./directory.ts";
import { Messages } from "./messages.ts";
import { Attention } from "./attention.ts";
import { MessageRecovery } from "./recovery.ts";
import { connectionPublication } from "./publication.ts";
import { Transcript } from "./transcript.ts";
import { catalogEventTypes, DirectoryCatalogs } from "./catalogs.ts";
import { CatalogExecutor } from "./catalog-executor.ts";
import { type PendingQuestion, PendingQuestions } from "./pending-questions.ts";
const BOOTSTRAP_EVENT_LIMIT = 128;
const BOOTSTRAP_TEXT_BUDGET = 4 * 1024 * 1024;
const contentEvents = new Set([
  ...catalogEventTypes,
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "session.error",
  "server.instance.disposed",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.delta",
  "message.part.removed",
  "todo.updated",
  "session.diff",
]);
export class OpencodeV1Adapter implements Harness {
  #retention = new V1RecordRetention();
  #failureAttempts = new FailureAttempts();
  #failureTurns = new Map<
    string,
    { candidate?: string; prompt?: string; created?: number }
  >();
  storage(storage: import("@otk/harness").PluginStorage): void {
    this.#retention.bind(storage);
  }
  readonly core: HarnessCore;
  readonly capabilities: Readonly<Capabilities>;
  readonly kind = "opencode-v1";
  version = "unknown";
  readonly client: Client;
  #sink!: HarnessSink;
  #target!: HarnessSink;
  #index = new SessionIndex();
  #attention = new Attention(
    (id) => this.#index.getMetadata(id),
    (entry) => this.#sink.indexUpsert(entry),
    (id) => this.#sink.indexRemove(id),
    (id) => this.#index.descendants(id),
  );
  #permissions = new Map<string, PendingPermission>();
  #questions: PendingQuestions;
  readonly catalogs: DirectoryCatalogs;
  #catalogExecutor?: CatalogExecutor;
  #catalogReads: import("@otk/harness").ProviderReadPort;
  #clocks: MessageClocks;
  #selectionIntents = new SelectionIntents();
  #revertReads = new Map<string, AbortController>();
  #revertRecords = new Map<string, {
    boundaryID: string;
    record: Promise<RevertInfo>;
  }>();
  get #stopped(): boolean {
    return !this.#run || this.#run.controller.signal.aborted;
  }
  #commands = new Map<
    AbortController,
    { sessionID: string; task: Promise<void> }
  >();
  #errors = new SessionErrors(
    (id, state) => this.#publishErrors(id, state),
    (id) =>
      !this.#stopped &&
      (!!this.#index.getMetadata(id) || this.buffers.subscribed(id)),
    (id) =>
      this.#stopped
        ? undefined
        : this.#index.getMetadata(id)?.attention.errorState,
  );
  #controller?: AbortController;
  #run?: { controller: AbortController; task: Promise<void> };
  #stopping?: Promise<void>;
  #db: BootstrapDb;
  #history: History;
  #tasks: TaskProgress;
  #helperObservation?: () => void;
  #messages: Messages;
  #colors: AgentColors;
  #replay: ContentReplay;
  #transcript: Transcript;
  #recovery: MessageRecovery;
  #records: RecordProjection;
  #reverts = new Map<string, string>();
  #connection = 0;
  #digestRevision = 0;
  #recoveryRevision = 0;
  #retired = new Set<string>();
  #hydrated = new Set<string>();
  #ignoredEvents = new Map<string, number>();
  get ignoredEvents(): ReadonlyMap<string, number> {
    return new Map(this.#ignoredEvents);
  }
  #ignored(type: string): void {
    const count = this.#ignoredEvents.get(type) ?? 0;
    this.#ignoredEvents.set(type, count + 1);
    if (!count) this.diagnostic("debug", `harness event ignored: ${type}`);
  }
  constructor(
    readonly cfg: OpencodeV1AdapterConfig,
    readonly buffers: StreamBuffers = new StreamBuffers(),
    fetcher = fetch,
    readonly digest?: DigestPort,
    readonly diagnostic: DiagnosticSink = () => {},
  ) {
    this.#records = new RecordProjection(cfg.messages);
    this.#replay = new ContentReplay({
      ...cfg.messages,
      nonce: () => crypto.randomUUID(),
      emit: (id, event, clock) => this.#target?.content(id, event, clock),
    });
    this.client = new Client(
      cfg.harness,
      fetcher,
      undefined,
      digest?.admission
        ? (signal) => digest.admission!(signal)
        : !digest
        ? (signal) => this.#catalogExecutor!.admission(signal)
        : undefined,
    );
    this.#questions = new PendingQuestions(
      cfg.catalogs.pending,
      (before, after) => {
        if (before && before.request.id !== after?.request.id) {
          this.#questionFresh.delete(before.request.id);
        }
        if (after) this.#questionFresh.set(after.request.id, this.#connection);
        const old = before?.request.sessionID, next = after?.request.sessionID;
        if (old !== next) {
          if (old) this.#attention.change(old, "questions", -1);
          if (next) this.#attention.change(next, "questions", 1);
        }
        for (
          const directory of new Set([before?.directory, after?.directory])
        ) {
          if (directory) {
            this.catalogs.update(
              directory,
              "questions",
              this.#questions.directory(directory),
            );
          }
        }
      },
      // Startup inventory, a demand-driven inventory read and live asks all
      // admit through this owner, so a later outcome keeps the request facts.
      (request) =>
        void this.#errors.retainHistory(
          request.sessionID,
          `question.observe:${request.id}`,
          () =>
            this.#retention.observe(
              request.sessionID,
              `question:${request.id}`,
              { ...request },
              Date.now(),
            ),
        ).catch((error) =>
          this.diagnostic("warn", "pending question history", error)
        ),
    );
    const catalogReads = digest ??
      (this.#catalogExecutor = new CatalogExecutor(
        cfg,
        cfg.digest,
        cfg.catalogs.concurrency,
        cfg.catalogs.statconcurrency,
        fetcher,
        (id) => this.#directory(id),
      ));
    this.#catalogReads = catalogReads;
    this.#clocks = new MessageClocks(
      catalogReads,
      cfg.messages.recoverypending,
      (id) => {
        if (!this.#stopped && this.buffers.subscribed(id)) {
          this.#sink.content(
            id,
            { op: "stream.reconcile" },
          );
        }
      },
      (error) => this.diagnostic("warn", "message clock", error),
    );
    this.catalogs = new DirectoryCatalogs(catalogReads, {
      pending: cfg.catalogs.pending,
      questions: this.#questions,
      watchFiles: true,
      diagnostic: (error) =>
        this.diagnostic("warn", "directory catalog", error),
    });
    this.#db = new BootstrapDb(harnessDb(cfg), this.diagnostic);
    this.#history = new History(catalogReads, cfg.attachments, this.diagnostic);
    this.#messages = new Messages(this.client, (id) => this.#directory(id));
    this.#colors = new AgentColors(
      this.client,
      (colors, sessions) => {
        const controller = this.#controller;
        if (!controller || !this.#current(controller)) return;
        for (const [id, owner] of sessions) {
          if (owner === controller && this.buffers.subscribed(id)) {
            this.#sink.content(id, {
              op: "agent.colors",
              colors: Object.fromEntries(colors),
            });
          }
        }
      },
      () => this.#controller,
      this.catalogs,
      this.diagnostic,
    );
    this.#recovery = new MessageRecovery({
      concurrency: cfg.messages.recoveryconcurrency,
      pending: cfg.messages.recoverypending,
      wanted: (id) => this.buffers.subscribed(id),
      read: (session, message, signal) =>
        this.#messages.get(session, message, signal),
      emit: (session, snapshot, parts, _generation, terminal) => {
        if (this.#stopped || !this.buffers.subscribed(session)) return;
        const cutoff = this.#reverts.get(session);
        if (cutoff && snapshot.info.id >= cutoff) return;
        if (ids.encode(snapshot.info.sessionID) !== session) {
          throw new Error("Recovery session identity mismatch");
        }
        this.#records.seed(snapshot);
        if (snapshot.info.role === "user" || snapshot.info.summary === true) {
          this.#sink.content(session, {
            op: "message.upsert",
            message: mapMessage(snapshot.info, snapshot.parts),
          });
          return;
        }
        // A point read may discover the header for the first time. Publish it
        // before its parts; HTTP observations never advance native output clocks.
        const message = mapMessage(
          snapshot.info,
          [],
          messageOutput(snapshot.parts).lastOutput ?? undefined,
          mapPart,
          snapshot.parts,
        );
        if (isAssistantTerminal(message)) {
          this.buffers.removeMessage(snapshot.info.id, session);
        }
        this.#sink.content(session, {
          op: "message.upsert",
          message: { ...message, parts: [] },
        });
        for (const part of message.parts) {
          this.#sink.content(session, {
            op: "part.upsert",
            messageID: message.id,
            part,
          });
        }
        this.buffers.epoch(session, this.#replay.clock(session).epoch);
        for (const raw of snapshot.parts) {
          if (!parts.has(raw.id)) continue;
          const known = this.buffers.snapshot(raw.id, session, snapshot.info.id)
            ?.part;
          if (
            !terminal && known && raw.time?.end === undefined &&
            (raw.text?.length ?? 0) <= (known.stream?.sourceLength ?? 0)
          ) continue;
          if (raw.time?.end !== undefined) this.buffers.remove(raw.id);
          const part = mapPart(raw);
          if (
            (part.kind === "text" || part.kind === "reasoning") && !terminal &&
            !isAssistantTerminal(message) &&
            raw.time?.end === undefined
          ) {
            part.stream = this.buffers.replacement(
              session,
              raw.text?.length ?? 0,
            );
          }
          this.#sink.content(session, {
            op: "part.upsert",
            messageID: snapshot.info.id,
            part,
          });
          if (!terminal && raw.time?.end !== undefined) {
            this.#recovery.part(snapshot.info.id, raw.id, session);
          }
        }
        if (!terminal && isAssistantTerminal(message)) {
          this.#recovery.message(snapshot.info.id, session);
        }
      },
      state: (session, messageID, partID, generation, state) => {
        if (!this.#stopped && this.buffers.subscribed(session)) {
          this.#sink.content(session, {
            op: "stream.recovery",
            messageID,
            partID,
            generation,
            state,
          });
        }
      },
      reconcile: (session) => {
        if (!this.#stopped && this.buffers.subscribed(session)) {
          this.#sink.content(session, { op: "stream.reconcile" });
        }
      },
      failed: (error) => this.diagnostic("warn", "message recovery", error),
    });
    this.#tasks = new TaskProgress({
      peek: (id) => this.#index.helper(id),
      ...(digest
        ? {
          request: (id: string) =>
            digest.observe(this.#connection, [{
              sessionID: id,
              revision: ++this.#digestRevision,
              reason: "helper-hint",
            }]),
        }
        : {}),
      subscribed: (id) => this.buffers.subscribed(id),
      emit: (parent, event) => {
        const cutoff = this.#reverts.get(parent);
        if (
          !this.#stopped &&
          (!cutoff || !("messageID" in event) || !event.messageID ||
            event.messageID < cutoff)
        ) this.#sink.content(parent, event);
      },
    });
    const directory = sessionDirectory(
      (id) => this.#directory(id),
      (id, signal) =>
        this.client.json<Session>(
          `/session/${encodeURIComponent(ids.decode(id))}`,
          { signal },
        ),
      digest
        ? (wanted, signal) =>
          digest.read("identity.batch", { ids: [...wanted] }, {
            owner: `identity:${crypto.randomUUID()}`,
            priority: "user",
            signal,
          })
        : undefined,
    );
    const version = () => this.version;
    this.#transcript = new Transcript({
      replay: this.#replay,
      invalidated: (value) => this.#sink.invalidate(value),
      retire: (id) => {
        this.#tasks.release(id);
        this.#recovery.release(id);
        this.#clocks.release(id);
        this.#records.release(id === undefined ? undefined : ids.decode(id));
        if (id === undefined) this.#selectionIntents.clear();
        else this.#selectionIntents.release(ids.decode(id));
        this.#releaseRevert(id);
      },
      recovering: (id) => this.#recovery.snapshot(id),
      scopedRecovery: (id) => this.#recovery.scoped(id),
      reconciled: (id, messageID, partID) => {
        if (partID === undefined) this.#recovery.message(messageID, id);
        else this.#recovery.part(messageID, partID, id);
      },
      buffers: this.buffers,
      reader: this.#messages,
      policy: cfg.messages,
      requested: () => this.#catalogExecutor?.requested(),
      prefetch: (input, signal) =>
        this.#catalogReads.read("opcv1.message.prefetch", input, {
          owner: `message-prefetch:${crypto.randomUUID()}`,
          priority: "background",
          optional: true,
          signal,
        }),
      raw: (id, signal) =>
        this.client.json<Session>(
          `/session/${encodeURIComponent(ids.decode(id))}`,
          { query: { directory: this.#directory(id) }, signal },
        ),
      info: async (raw, signal) => {
        const revert = await this.#revertInfo(raw, signal);
        return {
          ...mapSession(raw),
          revert,
        };
      },
      errorState: (id) => this.#errors.snapshot(id),
      metadata: digest
        ? (id, turns, signal, cutoff, boundary) =>
          digest.transcriptMetadata(id, turns, signal, cutoff, boundary)
        : undefined,
      decorate: (message, raw, directory, snapshot) => {
        if (!snapshot && this.buffers.subscribed(message.sessionID)) {
          this.#records.seed(raw);
        }
        const colors = this.#colors.peek(
          directory,
          !snapshot && this.buffers.subscribed(message.sessionID)
            ? message.sessionID
            : undefined,
        );
        if (message.role !== "context" && message.agent !== undefined) {
          message.agentColor = colors?.get(message.agent);
        }
        if (snapshot) return message;
        for (const [i, part] of raw.parts.entries()) {
          if (part.type === "tool" && part.tool === "task") {
            message.parts[i] = referencePart({
              kind: "tool",
              id: part.id,
              call: this.#tasks.shape(part),
            }, part.messageID);
          }
        }
        return message;
      },
      summaries: (id, turns) => {
        const known = this.#index.get(id)?.digest.turns;
        return Object.fromEntries(
          turns.filter((turn) => known?.[turn]).map((
            turn,
          ) => [turn, known![turn]]),
        );
      },
      retained: (id, before, limit) =>
        this.#retention.page(id, before, limit).map(recordReference),
    });
    this.core = sessions(
      this.client,
      directory,
      {
        kind: this.kind,
        get version() {
          return version();
        },
        start: (sink) => this.#start(sink),
        stop: () => this.#stop(),
        subscriptions: (id, count) => this.#subscriptions(id, count),
      },
      this.#transcript,
      async (input, signal) => {
        const value = await this.#catalogReads.read("sessions.list", input, {
          owner: `session-list:${crypto.randomUUID()}`,
          priority: "user",
          signal,
        });
        for (const entry of value.items) {
          const current = this.#index.getMetadata(entry.id);
          this.#sink.indexUpsert(
            current
              ? {
                ...entry,
                status: current.status,
                retry: current.retry,
                attention: current.attention,
              }
              : entry,
          );
        }
        return value;
      },
    );
    const listMessages = this.core.listMessages.bind(this.core);
    this.core.listMessages = async (id, input, signal) => {
      if (input.retryRecovery) this.#recovery.retry(id);
      await this.#errors.retryHistory(id);
      return await listMessages(id, input, signal);
    };
    this.core.hydrate = async (
      wanted,
      signal = new AbortController().signal,
    ) => {
      const remaining = new Set(wanted);
      const done = new Set<string>();
      while (remaining.size) {
        signal.throwIfAborted();
        const keys = [...remaining].filter((id) => !done.has(id));
        remaining.clear();
        if (!keys.length) break;
        const missing = keys.filter((id) => !this.#hydrated.has(id));
        if (missing.length && digest?.hydrate) {
          await digest.hydrate(missing, signal);
        } else if (missing.length) {
          for (const id of missing) {
            const raw = await this.client.json<Session>(
              `/session/${encodeURIComponent(ids.decode(id))}`,
              { signal },
            );
            const metadata = mapIndex(raw),
              current = this.#index.getMetadata(id);
            this.#sink.indexUpsert(
              current
                ? {
                  ...metadata,
                  status: current.status,
                  attention: current.attention,
                }
                : metadata,
            );
          }
        }
        for (const id of keys) {
          done.add(id);
          if (this.#index.getMetadata(id)) this.#hydrated.add(id);
          const parent = this.#index.getMetadata(id)?.parentID;
          if (parent && !done.has(parent)) remaining.add(parent);
        }
      }
    };
    const registry = new CapabilityRegistry();
    const launch: Launch = (...args) => this.#launch(...args);
    registry.register(
      "prompt",
      (() => {
        const capability = prompt(
          this.client,
          directory,
          (id) => {
            this.#abortCommands(id);
            this.#errors.cancel(id);
          },
          cfg.attachments,
          (sessionID, messageID, origin) => {
            this.#retention.observe(sessionID, `submission:${messageID}`, {
              origin,
            }, Date.now());
          },
        );
        return {
          ...capability,
          prompt: async (
            input: Parameters<typeof capability.prompt>[0],
            operation?: Parameters<typeof capability.prompt>[1],
          ) => {
            this.#admitFailureTurn(input.sessionID);
            const token = this.#errors.begin(
              input.sessionID,
              undefined,
              operation?.key.key,
            );
            try {
              return await capability.prompt(input, operation);
            } catch (error) {
              if (!operation?.signal.aborted) {
                this.#requestFailure(
                  input.sessionID,
                  "prompt",
                  error,
                  undefined,
                  operation?.key.origin,
                  token,
                );
              }
              throw error;
            } finally {
              this.#errors.settled(token);
            }
          },
        };
      })(),
    );
    registry.register("shell", shell(this.client, directory, launch));
    registry.register(
      "commands",
      (() => {
        const capability = commands(
          this.client,
          directory,
          launch,
          this.catalogs,
          cfg.attachments,
        );
        return {
          ...capability,
          command: async (
            input: Parameters<typeof capability.command>[0],
            operation?: Parameters<typeof capability.command>[1],
          ) => {
            try {
              await capability.command(input, operation);
            } catch (error) {
              if (!operation?.signal.aborted) {
                this.#requestFailure(
                  input.sessionID,
                  "command",
                  error,
                  undefined,
                  operation?.key.origin,
                  undefined,
                  operation?.key.key,
                );
              }
              throw error;
            }
          },
        };
      })(),
    );
    registry.register("history", this.#history);
    registry.register("catalogs", {
      watch: (directory, listener, signal) => {
        signal.throwIfAborted();
        const lease = this.catalogs.acquire(directory, true);
        const stop = lease.subscribe(() => listener(lease.snapshot()));
        const release = () => {
          stop();
          lease.release();
        };
        signal.addEventListener("abort", release, { once: true });
        const value = lease.snapshot();
        queueMicrotask(() => {
          if (!signal.aborted) listener(lease.snapshot());
        });
        return Promise.resolve(value);
      },
      demand: (directory, demand, signal) =>
        this.catalogs.demand(directory, demand, signal),
      refresh: async (directory, signal, kinds) => {
        signal?.throwIfAborted();
        const lease = this.catalogs.acquire(directory);
        try {
          await lease.refresh(signal, kinds);
          signal?.throwIfAborted();
        } finally {
          lease.release();
        }
      },
    });
    registry.register("files", files(this.client, directory, this.catalogs));
    registry.register("agents", agents(this.client, directory, this.catalogs));
    registry.register("models", models(this.client, directory, this.catalogs));
    registry.register(
      "usage",
      digest
        ? {
          getUsage: async (id, turnID, signal) => {
            const clock = this.#replay.clock(id);
            const version = this.#replay.version(id);
            const detail = await digest.detail(
              id,
              turnID,
              signal ?? new AbortController().signal,
            );
            return { ...detail, clock, version };
          },
        }
        : {
          getUsage: async (id, turnID, signal) => {
            const clock = this.#replay.clock(id);
            const version = this.#replay.version(id);
            return {
              ...await usage(this.#db, this.#messages, directory).getUsage(
                id,
                turnID,
                signal,
              ),
              clock,
              version,
            };
          },
        },
    );
    registry.register("source", {
      getSource: async (id, ref, signal) => {
        let value: ReturnType<typeof parseSourceRef>;
        try {
          value = parseSourceRef(ref);
        } catch {
          throw sourceFailure("reference");
        }
        let derived;
        if (value.origin === "record") {
          derived = this.#retention.get(id, value.id)?.message;
          if (!derived) throw sourceFailure("record");
        } else {
          try {
            const raw = await this.#messages.get(id, value.id, signal);
            derived = deriveMessage(raw.info, raw.parts);
          } catch (error) {
            signal?.throwIfAborted();
            throw sourceFailure(
              error instanceof NativeRequestFailure &&
                error.original instanceof HttpFailure &&
                error.original.status === 404
                ? "message"
                : error instanceof NativeRequestFailure &&
                    error.outcome === "unavailable"
                ? "unreachable"
                : "read",
            );
          }
        }
        const view = sourceAt(derived, value.path);
        if (!view) throw sourceFailure("item");
        return view;
      },
    });
    if (digest) {
      registry.register("digests", {
        scope: (owner, value) => digest.scope(owner, value),
        release: (owner) => digest.release(owner),
      });
    }
    registry.register(
      "resources",
      resources(this.client, directory, this.catalogs),
    );
    const nativeActions = sessionActions(
      this.client,
      directory,
      this.#db,
      this.#messages,
      async (id) =>
        (await this.client.json<Session>(
          `/session/${encodeURIComponent(ids.decode(id))}`,
          { query: { directory: await directory.resolve(id) } },
        )).revert?.messageID,
      launch,
    );
    registry.register(
      "sessionActions",
      {
        ...nativeActions,
        remove: async (id) => {
          ids.decode(id);
          if (!digest) return await nativeActions.remove(id);
          let metadata = this.#metadata(id);
          if (!metadata) {
            metadata = mapIndex(
              await this.client.json<Session>(
                `/session/${encodeURIComponent(ids.decode(id))}`,
              ),
            );
            if (metadata.id !== id) {
              throw new HarnessError(
                "session",
                "Session metadata does not match the requested session.",
              );
            }
            this.#errors.register(id);
            this.#errorEntry(metadata);
            this.#attention.upsert(metadata);
          }
          const intent = crypto.randomUUID(), connection = this.#connection;
          await digest.deleteIntent(id, intent, "begin", connection);
          try {
            await nativeActions.remove(id);
            await digest.deleteIntent(id, intent, "confirmed", connection);
            await digest.deleted(
              connection,
              id,
              ++this.#digestRevision,
              metadata,
            );
          } catch (error) {
            await digest.deleteIntent(id, intent, "failed", connection);
            throw error;
          }
        },
      },
    );
    registry.register(
      "permissions",
      permissions(
        this.client,
        directory,
        (id) => this.#index.getMetadata(id),
        () => this.#permissions.values(),
      ),
    );
    registry.register(
      "questions",
      questions(
        this.client,
        directory,
        (id) => this.#index.getMetadata(id),
        this.#questions,
        (directory, signal) =>
          this.catalogs.get(directory, "questions", signal),
      ),
    );
    registry.register(
      "revert",
      revert(this.client, directory, (id) => this.core.getSession(id)),
    );
    registry.register(
      "restore",
      restore(this.client, directory, (id) => this.core.getSession(id)),
    );
    registry.register(
      "projectEdit",
      projectEditor(
        this.client,
        () => this.catalogs.invalidateAll(["project"]),
      ),
    );
    this.capabilities = registry.capabilities;
  }
  #start(sink: HarnessSink): Promise<void> {
    if (this.#run || this.#stopping) {
      return Promise.reject(
        new HarnessError("started", "Harness is already started"),
      );
    }
    this.#index = sink.index ?? new SessionIndex();
    this.#helperObservation = this.#index.observeDigest((id) => {
      const summary = this.#index.helper(id);
      if (summary) this.#tasks.update(id, summary);
    });
    // Standalone consumers need no index implementation. In core, callbacks
    // already mutate the injected owner; never maintain a mirrored map.
    this.#target = sink.index ? sink : {
      ...sink,
      indexReset: (entries) => {
        this.#index.reset(entries);
        sink.indexReset(entries);
      },
      indexUpsert: (entry) => {
        this.#index.upsert(entry);
        sink.indexUpsert(entry);
      },
      indexRemove: (id) => {
        this.#index.remove(id);
        sink.indexRemove(id);
      },
    };
    const run = this.#run = {
      controller: new AbortController(),
      task: Promise.resolve(),
    };
    this.#sink = this.#publication(run.controller.signal);
    if (this.digest) {
      this.#deliveryJoin = new DeliveryJoin(
        this.digest,
        (id, fact) => this.#applyDelivered(id, fact),
        (error) =>
          this.diagnostic("warn", "delivery evidence unavailable", error),
        this.digest.publishrows ?? this.cfg.digest.publishrows,
      );
    }
    const opening = this.digest?.start() ?? Promise.resolve();
    run.task = opening.then(async () => {
      if (!run.controller.signal.aborted) {
        await this.#loop(run.controller.signal);
      }
    });
    sink.connection("connecting");
    return opening;
  }
  #stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#run?.controller.abort();
    this.#controller?.abort();
    this.#stopping = this.#shutdown().finally(() => {
      this.#run = undefined;
      this.#stopping = undefined;
    });
    return this.#stopping;
  }
  #publication(signal: AbortSignal): HarnessSink {
    const evidence = (entry: IndexEntry): IndexEntry => {
      if (this.#idle.get(entry.id) === this.#connection && !signal.aborted) {
        this.#terminals.set(
          entry.id,
          latestTerminal(
            this.#terminals.get(entry.id),
            this.#terminalCandidates.get(entry.id),
          ),
        );
      }
      const inputs = [...this.#questions.values()].filter((p) =>
        p.request.sessionID === entry.id &&
        this.#questionFresh.get(p.request.id) === this.#connection
      ).map((p) => p.request.id);
      const permissions = [...this.#permissions.values()].filter((p) =>
        p.request.sessionID === entry.id && p.generation === this.#connection
      ).map((p) => p.request.id);
      // Delivery is the digest store's durable fact. A published entry
      // carries the last fact joined from that store; rows never replace it.
      const published = this.#index.getMetadata(entry.id);
      const delivered = published
        ? published.activity?.delivered
        : entry.activity?.delivered;
      const terminal = this.#terminals.get(entry.id)?.terminal ?? 0;
      if (
        entry.parentID && terminal > (delivered?.terminal ?? 0)
      ) this.#deliveryJoin?.request([entry.id]);
      return ({
        ...entry,
        activity: {
          ...this.#terminals.get(entry.id),
          ...(entry.activity?.terminalOrigin === "historical"
            ? { terminalOrigin: "historical" as const }
            : {}),
          delivered,
          work: {
            keys: this.#liveWork.has(entry.id)
              ? [this.#liveWork.get(entry.id)!.key]
              : [],
            fresh: !signal.aborted &&
              this.#liveWork.get(entry.id)?.generation === this.#connection,
          },
          inputs: {
            keys: inputs,
            fresh: !signal.aborted &&
              (inputs.length > 0 || this.#questions.known(entry.directory)),
          },
          permissions: {
            keys: permissions,
            fresh: !signal.aborted &&
              (permissions.length > 0 ||
                this.#permissionInventories.get(entry.directory) ===
                  this.#connection),
          },
        },
      });
    };
    return connectionPublication({
      ...this.#target,
      indexUpsert: (entry) => this.#target.indexUpsert(evidence(entry)),
      indexReset: (entries) => this.#target.indexReset(entries.map(evidence)),
      content: (id, event) => {
        if (isAttentionOp(event)) this.#target.content(id, event);
        else this.#replay.publish(id, event);
      },
    }, signal);
  }
  #liveWork = new Map<string, { key: string; generation: number }>();
  #terminals = new Map<string, TerminalEvidence>();
  #deliveries?: DeliveryBackfill;
  #deliveryJoin?: DeliveryJoin;
  #applyDelivered(
    id: string,
    fact: import("@otk/protocol").DeliveredEvidence | undefined,
  ): void {
    const entry = this.#index.getMetadata(id);
    if (
      !this.#run || !entry ||
      JSON.stringify(entry.activity?.delivered) === JSON.stringify(fact)
    ) return;
    this.#target.indexUpsert({
      ...entry,
      activity: {
        ...entry.activity,
        delivered: fact,
        terminalOrigin: "historical",
      },
    });
  }
  #terminalCandidates = new Map<string, TerminalEvidence>();
  #idle = new Map<string, number>();
  #questionFresh = new Map<string, number>();
  #permissionInventories = new Map<string, number>();
  async #shutdown(): Promise<void> {
    await this.#deliveries?.stop();
    this.#deliveries = undefined;
    await this.#deliveryJoin?.stop();
    this.#deliveryJoin = undefined;
    this.#failureTurns.clear();
    this.#failureAttempts.clear();
    this.#helperObservation?.();
    this.#helperObservation = undefined;
    this.#abortCommands();
    this.buffers.stop();
    this.#errors.reset();
    await this.#tasks.stop();
    await this.#recovery.stop();
    this.#colors.clear();
    await this.catalogs.stop();
    await this.#catalogExecutor?.stop();
    this.#permissions.clear();
    this.#questions.clear();
    this.#questionFresh.clear();
    this.#permissionInventories.clear();
    this.#liveWork.clear();
    this.#terminals.clear();
    this.#terminalCandidates.clear();
    this.#idle.clear();
    this.#selectionIntents.clear();
    this.#reverts.clear();
    this.#revertRecords.clear();
    this.#transcript.release();
    this.#retired.clear();
    this.#attention.reset([], [], []);
    // Stop the digest before joining opening: its retired startup gate wakes
    // the adapter's run task, including when a signal arrived during startup.
    const digestStop = this.digest?.stop();
    const completed = await Promise.allSettled([
      this.#run?.task,
      digestStop,
      ...[...this.#commands.values()].map((request) => request.task),
    ]);
    this.#db.close();
    this.#history.close();
    const failed = completed.filter((result): result is PromiseRejectedResult =>
      result.status === "rejected" && !isCancellation(result.reason)
    );
    if (failed.length) {
      throw new AggregateError(
        failed.map((result) => result.reason),
        "Harness lifetime failed",
      );
    }
  }
  #subscriptions(id: string, count: number): void {
    this.buffers.subscriptions(id, count);
    if (count) this.buffers.epoch(id, this.#replay.clock(id).epoch);
    if (count && !this.#stopped) {
      this.buffers.replay(
        id,
        (sessionID, op) => {
          if (
            op.op === "part.upsert" &&
            (op.part.kind === "text" || op.part.kind === "reasoning") &&
            op.part.stream?.recovering
          ) this.#recovery.touch(sessionID, op.messageID, op.part.id);
          this.#sink.content(sessionID, op);
        },
      );
    }
    if (!count) this.#errors.release(id);
    if (!count) this.#tasks.release(id);
    if (!count) this.#colors.release(id);
    if (!count) this.#reverts.delete(id);
    if (!count) this.#recovery.release(id);
    if (!count) this.#clocks.release(id);
    if (!count) this.#records.release(ids.decode(id));
    if (!count) this.#selectionIntents.release(ids.decode(id));
    if (!count) this.#releaseRevert(id);
    if (!count) this.#transcript.release(id);
  }
  #directory(id: string): string | undefined {
    return this.#index.getMetadata(id)?.directory;
  }
  #releaseRevert(id?: string): void {
    for (const [key, controller] of this.#revertReads) {
      if (id !== undefined && key !== id) continue;
      this.#revertReads.delete(key);
      controller.abort();
    }
  }
  async #revertInfo(
    session: Session,
    signal = this.#controller?.signal,
    priority: import("@otk/harness").ProviderReadOptions["priority"] = "user",
  ): Promise<RevertInfo | undefined> {
    const id = ids.encode(session.id);
    if (!session.revert) {
      this.#reverts.delete(id);
      this.#revertRecords.delete(id);
      return;
    }
    if (this.buffers.subscribed(id)) {
      this.#reverts.set(id, session.revert.messageID);
      this.#tasks.cutoff(id, session.revert.messageID);
    }
    const previous = this.#revertRecords.get(id);
    if (previous?.boundaryID === session.revert.messageID) {
      const files = session.revert.diff
        ? parseDiff(session.revert.diff)
        : mapDiffs(session.summary?.diffs || []);
      return {
        ...await previous.record,
        files: files.map(({ path, additions, deletions }) => ({
          path,
          additions,
          deletions,
        })),
      };
    }
    const record = this.#resolveRevert(session, signal, priority);
    this.#revertRecords.set(id, {
      boundaryID: session.revert.messageID,
      record,
    });
    try {
      return await record;
    } catch (error) {
      if (this.#revertRecords.get(id)?.record === record) {
        this.#revertRecords.delete(id);
      }
      throw error;
    }
  }
  async #resolveRevert(
    session: Session,
    signal: AbortSignal | undefined,
    priority: import("@otk/harness").ProviderReadOptions["priority"],
  ): Promise<RevertInfo> {
    const id = ids.encode(session.id), boundaryID = session.revert!.messageID;
    let messageIDs = this.#db.revertedMessageIDs(id, boundaryID);
    if (!messageIDs?.includes(boundaryID)) messageIDs = undefined;
    let prompt: import("@otk/protocol").HistoryEntry | undefined;
    try {
      prompt = await this.#history.entry(
        id,
        boundaryID,
        signal,
        priority,
      );
    } catch (error) {
      signal?.throwIfAborted();
      // An unavailable native DB retains the existing API fallback boundary.
      if (messageIDs !== undefined) throw error;
    }
    if (messageIDs === undefined) {
      messageIDs = [];
      let boundary: import("./messages.ts").NativeMessage | undefined;
      let command: string | undefined;
      for await (
        const message of this.#messages.scan(id, session.directory, signal)
      ) {
        if (
          message.info.role === "assistant" &&
          message.info.parentID === boundaryID
        ) {
          const input = message.parts.find((p) =>
            p.type === "tool" && p.tool === "bash"
          )?.state?.input.command;
          if (typeof input === "string") command = input;
        }
        if (
          message.info.id >= boundaryID
        ) {
          messageIDs.push(message.info.id);
          if (message.info.id === boundaryID) boundary = message;
        }
      }
      messageIDs.sort();
      if (boundary) {
        const shell = boundary.parts.some((p) =>
          p.type === "text" && p.synthetic &&
          p.text === "The following tool was executed by the user"
        );
        prompt = historyEntry(
          boundary.info.id,
          boundary.info.time.created,
          boundary.parts,
          shell ? command : undefined,
        );
      }
    }
    const files = session.revert!.diff
      ? parseDiff(session.revert!.diff)
      : mapDiffs(session.summary?.diffs || []);
    return {
      boundaryID,
      messageIDs,
      prompt,
      files: files.map(({ path, additions, deletions }) => ({
        path,
        additions,
        deletions,
      })),
    };
  }
  #failureCreated(sessionID: string, recordID?: string): number {
    const previous = recordID && this.#retention.get(sessionID, recordID);
    if (previous) return previous.created;
    // Retained timestamps are the transcript's ordering keys. Allocate once at
    // receipt, including equal/backward clocks; updates keep their original key.
    const latest = this.#retention.page(sessionID, undefined, 1)[0];
    return Math.max(
      Date.now(),
      this.#failureTurns.get(sessionID)?.created ?? 0,
      latest ? latest.time.created + 1 : 0,
    );
  }
  #requestFailure(
    sessionID: string,
    action: string,
    error: unknown,
    recordID?: string,
    origin?: import("@otk/protocol").RequestOrigin,
    request?: ErrorRequest,
    requestID?: string,
  ): void {
    if (!this.#errors.accepts(sessionID)) return;
    if (
      !(error instanceof OperationFailure) ||
      !(error.outcome === "rejected" ||
        error.outcome === "unknown" && error.facts?.status !== undefined)
    ) {
      return;
    }
    // Launch failures may already have been retained before the capability's
    // admission promise rejects; preparation failures reach this owner here.
    if (error.facts?.record) return;
    const failure = {
      code: error.code,
      retry: error.outcome === "rejected"
        ? "new-intent" as const
        : "none" as const,
      diagnosticID: error.diagnosticID,
      facts: {
        ...error.facts,
        action: `session.${action}`,
        origin,
        target: { sessionID, label: this.#index.getMetadata(sessionID)?.title },
        outcome: error.outcome,
      },
    };
    const prior = recordID
      ? this.#retention.get(sessionID, recordID)?.message
      : undefined;
    const priorPart = prior?.parts.find((part) =>
      part.kind === "external" && part.failure
    );
    const priorFailure = priorPart?.kind === "external"
      ? priorPart.failure
      : undefined;
    if (priorFailure?.facts) {
      failure.facts = {
        ...failure.facts,
        outcome: priorFailure.facts.outcome === "rejected"
          ? "rejected"
          : failure.facts.outcome,
        status: failure.facts.status ?? priorFailure.facts.status,
        reason: [
          ...new Set(
            [priorFailure.facts.reason, failure.facts.reason].filter(Boolean),
          ),
        ].join("\n"),
      };
    }
    const message = requestFailureRecord(
      sessionID,
      failure,
      this.#failureCreated(sessionID, recordID),
      prior?.role === "context" ? prior.replyTo : undefined,
      recordID,
    );
    // Keep the original native failure class/certainty and diagnostic identity;
    // annotate its producer-selected facts only after the retained record exists.
    const record = message.parts[0].kind === "external"
      ? message.parts[0].failure?.facts?.record
      : undefined;
    this.#retention.put({
      id: message.id,
      sessionID,
      created: message.time.created,
      message,
    });
    if (error.facts && record) {
      error.facts.record = record;
      error.facts.origin = failure.facts.origin;
    }
    if (this.buffers.subscribed(sessionID)) {
      this.#sink.content(sessionID, { op: "message.upsert", message });
    }
    // Retained failure and inline observation borrow one diagnostic. Launch
    // failures consume their existing token; preparation failures have no launch.
    const token = request ?? this.#errors.begin(
      sessionID,
      action === "shell" || action === "command" || action === "compact"
        ? action
        : undefined,
      requestID,
    );
    const cause = error instanceof NativeRequestFailure
      ? error.original
      : error;
    this.#errors.http(token, {
      ...(cause instanceof HttpFailure
        ? { ...cause.detail, status: cause.status }
        : { message: errorMessage(error), kind: normalizeError(error).name }),
      ...(message.parts[0].kind === "external"
        ? { failure: message.parts[0].failure }
        : {}),
    });
  }
  /** An admitted operation cannot borrow a previous prompt's causal anchor. */
  #admitFailureTurn(sessionID: string): void {
    this.#failureAttempts.retire(sessionID);
    const turn = this.#failureTurns.get(sessionID);
    this.#failureTurns.set(sessionID, { created: turn?.created });
  }
  #launch(
    sessionID: string,
    operation: Parameters<Launch>[1],
    path: string,
    options: Parameters<Client["request"]>[1],
  ): ReturnType<Launch> {
    if (this.#stopped) throw new HarnessError("stopped", "Harness is stopped");
    this.#admitFailureTurn(sessionID);
    const controller = new AbortController();
    const token = this.#errors.begin(
      sessionID,
      operation,
      options?.operation?.key.key,
    );
    const failureAttempt = this.#failureAttempts.begin(
      sessionID,
      token.id,
      options?.operation?.key.origin,
    );
    const settled = this.client.json(path, {
      ...options,
      signal: controller.signal,
      classification: "effect",
    }).then(() => {
      this.#failureAttempts.settle(failureAttempt);
    });
    const request = settled.then(() => this.#errors.settled(token)).catch(
      (error) => {
        if (!this.#stopped && !controller.signal.aborted) {
          this.#failureAttempts.settle(failureAttempt);
          this.#requestFailure(
            sessionID,
            operation,
            error,
            failureAttempt.recordID,
            options?.operation?.key.origin,
            token,
          );
          const cause = error instanceof NativeRequestFailure
            ? error.original
            : error;
          this.#errors.http(
            token,
            cause instanceof HttpFailure
              ? {
                ...cause.detail,
                status: cause.status,
                ...(error instanceof NativeRequestFailure
                  ? { failure: error.failure }
                  : {}),
              }
              : {
                message: errorMessage(error),
                kind: normalizeError(error).name,
              },
          );
        }
      },
    ).finally(() => {
      this.#failureAttempts.settle(failureAttempt);
      this.#errors.settled(token);
      this.#commands.delete(controller);
    });
    this.#commands.set(controller, { sessionID, task: request });
    return { admitted: settled, settled };
  }
  #abortCommands(sessionID?: string): void {
    if (sessionID) this.#failureAttempts.retire(sessionID);
    else this.#failureAttempts.clear();
    for (const [controller, request] of this.#commands) {
      if (sessionID === undefined || request.sessionID === sessionID) {
        controller.abort();
      }
    }
  }
  #publishErrors(sessionID: string, errorState: SessionErrorState): void {
    if (this.#stopped) return;
    const error = sessionErrorMessage(errorState);
    const entry = this.#index.getMetadata(sessionID);
    if (entry) {
      this.#errorEntry(entry, errorState);
      this.#sink.indexUpsert(entry);
    }
    if (this.buffers.subscribed(sessionID)) {
      this.#sink.content(sessionID, { op: "session.error", error, errorState });
    }
  }
  #errorEntry(
    entry: IndexEntry,
    errorState = this.#errors.snapshot(entry.id),
  ): void {
    entry.attention.errorState = errorState;
    const error = sessionErrorMessage(errorState);
    if (error) entry.attention.error = error;
    else delete entry.attention.error;
  }
  #current(controller: AbortController): boolean {
    return !this.#stopped && this.#controller === controller &&
      !controller.signal.aborted;
  }
  async #loop(signal: AbortSignal): Promise<void> {
    const backoff = new Backoff(this.cfg.harness.reconnectmax);
    while (!signal.aborted) {
      const controller = this.#controller = new AbortController();
      const sink = this.#sink = this.#publication(controller.signal);
      this.#transcript.invalidate();
      controller.signal.addEventListener("abort", () => {
        this.#recovery.release();
        this.#clocks.release();
        this.#selectionIntents.clear();
        this.#releaseRevert();
        this.#tasks.release();
        this.buffers.suspend();
      }, { once: true });
      const watchdog = new Watchdog(
        this.cfg.harness.heartbeattimeout * 1000,
        () => controller.abort(),
      );
      let chain = Promise.resolve(), bootstrapping = false, ready = false;
      const buffered: Envelope[] = [];
      let bufferedBytes = 0;
      try {
        const health = await this.client.json<{ version: string }>(
          "/global/health",
          { signal: controller.signal },
        );
        controller.signal.throwIfAborted();
        this.version = health.version;
        watchdog.touch();
        const response = await this.client.request("/global/event", {
          signal: controller.signal,
          classification: "stream",
        });
        if (!this.#current(controller)) {
          await response.body?.cancel();
          controller.signal.throwIfAborted();
        }
        await consumeEvents(
          response,
          () => watchdog.touch(),
          (event, textLength) => {
            if (!this.#current(controller)) return;
            if (event.payload.type === "server.connected") {
              if (bootstrapping) return;
              bootstrapping = true;
              this.#questions.uncertain();
              this.catalogs.reset();
              this.#colors.reset();
              backoff.connected();
              chain = this.#bootstrap(controller).then(async () => {
                if (!this.#current(controller)) return;
                ready = true;
                sink.connection("connected");
                if (!this.#current(controller)) return;
                sink.bootstrapComplete();
                bufferedBytes = 0;
                for (const pending of buffered.splice(0)) {
                  if (!this.#current(controller)) break;
                  await this.#handle(pending, controller);
                }
              }).catch((error) => {
                if (this.#current(controller)) {
                  this.diagnostic("warn", "bootstrap", error);
                }
                controller.abort();
              });
            } else if (event.payload.type !== "server.heartbeat") {
              if (!ready) {
                // Bound both object count and retained serialized UTF-16 text.
                // One overflowing frame remains owned by the paused parser.
                const bytes = textLength * 2;
                if (
                  buffered.length < BOOTSTRAP_EVENT_LIMIT &&
                  bufferedBytes + bytes <= BOOTSTRAP_TEXT_BUDGET
                ) {
                  buffered.push(event);
                  bufferedBytes += bytes;
                  return;
                }
                // Our own backpressure makes transport heartbeats unobservable;
                // finite bootstrap requests still own their cancellation/deadline.
                watchdog.stop();
                chain = chain.then(() => this.#handle(event, controller))
                  .finally(() => {
                    if (this.#current(controller)) watchdog.touch();
                  });
                return chain;
              }
              chain = chain.then(() => this.#handle(event, controller));
              // Once bootstrap is ready, the parser owns at most the event being
              // forwarded, rather than accumulating content in a promise queue.
              return chain;
            }
          },
          (type) => {
            if (
              contentEvents.has(type) || type === "server.connected" ||
              type === "server.heartbeat"
            ) return true;
            this.#ignored(type);
            return false;
          },
          (error) => this.diagnostic("warn", "harness event", error),
          () => {
            if (bootstrapping && !ready) controller.abort();
          },
        );
      } catch (error) {
        if (this.#current(controller)) {
          this.diagnostic("warn", "harness stream", error);
        }
      } finally {
        watchdog.stop();
        controller.abort();
        await chain;
        buffered.length = 0;
        await this.#tasks.stop();
        this.#recovery.release();
        this.#controller = undefined;
      }
      if (signal.aborted) break;
      for (const entry of this.#index.snapshotEntries()) {
        this.#target.indexUpsert({
          ...entry,
          activity: {
            ...entry.activity,
            work: { keys: entry.activity?.work?.keys ?? [], fresh: false },
            inputs: { keys: entry.activity?.inputs?.keys ?? [], fresh: false },
            permissions: {
              keys: entry.activity?.permissions?.keys ?? [],
              fresh: false,
            },
          },
          activityAuthority: "stale",
        });
      }
      this.#target.connection("reconnecting");
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", wake);
          resolve();
        };
        const timer = setTimeout(wake, backoff.next());
        signal.addEventListener("abort", wake, { once: true });
        if (signal.aborted) wake();
      });
    }
  }
  async #bootstrap(controller: AbortController): Promise<void> {
    if (!this.#current(controller)) return;
    const sink = this.#sink;
    this.#hydrated.clear();
    this.#recovery.release();
    this.#records.release();
    this.#reverts.clear();
    this.#selectionIntents.clear();
    this.#tasks.release();
    this.buffers.rebind(
      (id) => this.#replay.clock(id).epoch,
      (id, messageID, partID) => this.#recovery.touch(id, messageID, partID),
    );
    // Transport replacement retains last-good event source. Actual instance
    // disposal retires that source at its explicit event boundary instead.
    const since = Date.now() - this.cfg.index.days * 86_400_000;
    const entries = new Map<string, IndexEntry>();
    // Catalog preparation and live publication share one cooperative budget.
    // Bounding only the final writes leaves error/attention reconciliation as
    // an inventory-sized synchronous section on reconnect.
    const budget = this.digest?.publishrows ?? this.cfg.digest.publishrows;
    let quota = budget;
    let until = performance.now() + this.cfg.digest.slicems;
    const each = async <T>(values: Iterable<T>, apply: (value: T) => void) => {
      for (const value of values) {
        if (!this.#current(controller)) return;
        apply(value);
        if (--quota === 0 || performance.now() >= until) {
          quota = budget;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          until = performance.now() + this.cfg.digest.slicems;
        }
      }
    };
    const connection = ++this.#connection;
    await this.#deliveries?.stop();
    this.#deliveries = undefined;
    const seeds = await this.digest?.projects?.(
      connection,
      controller.signal,
      (values) => sink.projectSeeds?.(values),
    );
    if (seeds) sink.projectSeeds?.(seeds.projects);
    if (seeds && this.#target.retainedSessions?.length) {
      await this.digest?.hydrate?.(
        this.#target.retainedSessions,
        controller.signal,
        true,
      );
      for (const id of this.#target.retainedSessions) {
        const entry = this.#index.getMetadata(id);
        if (entry) entries.set(id, entry);
      }
    }
    const catalog = seeds
      ? { entries: [], authoritative: true, hints: seeds.hints }
      : await this.digest?.catalog(
        connection,
        controller.signal,
      );
    if (catalog) {
      await each(catalog.entries, (entry) => entries.set(entry.id, entry));
    }
    if (seeds) {
      // Reconcile already-observed activity without replaying ordinary sessions.
      // Current empty candidates prove a formerly busy session idle; unavailable
      // authority retains its previous status in the reconciliation below.
      await each(this.#index.snapshotEntries(), (entry) => {
        const a = entry.attention;
        if (
          entry.deleted || entry.status === "idle" && !a.error &&
            a.permissions + a.questions + a.childPermissions +
                  a.childQuestions === 0
        ) return;
        const metadata = this.#index.getMetadata(entry.id)!;
        entries.set(entry.id, {
          ...metadata,
          status: "idle",
          retry: undefined,
        });
      });
    }
    let cursor: string | undefined;
    if (!catalog) {
      do {
        const response = await this.client.request("/experimental/session", {
          query: { limit: 200, cursor },
          signal: controller.signal,
        });
        if (!this.#current(controller)) {
          await response.body?.cancel();
          return;
        }
        const sessions = await response.json() as Session[];
        if (!this.#current(controller)) return;
        await each(sessions, (session) => {
          const entry = mapIndex(session);
          entries.set(entry.id, entry);
        });
        const next = response.headers.get("x-next-cursor") ?? undefined;
        if (next && next === cursor) {
          throw new Error("Harness session pagination did not advance");
        }
        cursor = next;
      } while (cursor);
    }
    const previousPermissions = new Map(this.#permissions);
    // Only positive terminal history is startup demand. It borrows the existing
    // source-proven worker connection and credited, bounded read channel.
    let after = "";
    const terminalParents = new Set<string>();
    for (;;) {
      if (!this.#current(controller)) return;
      let rows: IndexEntry[];
      try {
        rows = this.digest
          ? await this.digest.read("supervision.terminals", { after }, {
            owner: `supervision:${connection}`,
            priority: "attention",
            signal: controller.signal,
          })
          : this.#db.terminals(after, budget);
      } catch (error) {
        if (!this.#current(controller)) return;
        this.diagnostic("warn", "terminal evidence unavailable", error);
        break;
      }
      if (!rows.length) break;
      await each(rows, (row) => {
        const previous = entries.get(row.id);
        // The standalone DB is only a candidate source until its identity agrees
        // with this connection's API catalog. The worker already proves its file.
        if (
          !this.digest &&
          (!previous || previous.directory !== row.directory ||
            previous.timeCreated !== row.timeCreated)
        ) return;
        if (row.parentID) terminalParents.add(row.parentID);
        // Source-proven durable completions are terminal evidence themselves.
        // They do not demand a live native instance in every historical directory.
        // Fresh work/input inventories and subscribed events remain independent.
        this.#terminals.set(
          row.id,
          latestTerminal(this.#terminals.get(row.id), row.activity),
        );
        entries.set(row.id, {
          ...row,
          ...previous,
          activity: previous?.activity,
        });
      });
      after = rows.at(-1)!.id;
    }
    const nextPermissions = new Map<string, PendingPermission>();
    const nextQuestions = new Map<string, PendingQuestion>();
    const knownQuestionDirectories = new Set<string>();
    // Native directory reads create retained instances and touch project clocks.
    // Without native scalar authority only previously observed activity is a
    // candidate. A catalog directory is never itself permission to load an instance.
    const hints = catalog ? catalog.hints : await this.#db.activityCandidates(
      since,
      this.cfg.digest.batch,
      controller.signal,
    );
    const directories = new Set<string>();
    if (hints) await each(hints, (directory) => directories.add(directory));
    else {await each(this.#index.snapshotEntries(), (entry) => {
        const a = entry.attention;
        if (
          entry.status !== "idle" || a.error ||
          a.permissions + a.questions + a.childPermissions + a.childQuestions >
            0
        ) {
          directories.add(entry.directory);
        }
      });}
    await each(entries.values(), (entry) => {
      const previous = this.#index.getMetadata(entry.id);
      entry.activityAuthority = hints
        ? "current"
        : previous
        ? "stale"
        : "unknown";
      if (!hints && previous) {
        entry.status = previous.status;
        entry.retry = previous.retry;
      }
    });
    const byDirectory = new Map<string, IndexEntry[]>();
    await each(entries.values(), (entry) => {
      const local = byDirectory.get(entry.directory) ?? [];
      local.push(entry);
      byDirectory.set(entry.directory, local);
    });
    const routing = new Set<string>(terminalParents);
    const inventory = async (directory: string) => {
      const options = {
        owner: JSON.stringify(["activity", directory, this.#connection]),
        priority: "attention" as const,
        signal: controller.signal,
      };
      const read = async <
        K extends
          | "activity.status"
          | "activity.permissions"
          | "catalog.questions",
      >(kind: K) => {
        try {
          return await this.#catalogReads.read(kind, { directory }, options);
        } catch (error) {
          if (!this.#current(controller)) return;
          this.diagnostic(
            "warn",
            `bootstrap directory ${JSON.stringify(directory)} ${kind}`,
            error,
          );
          sink.error?.({
            code: "inventory.activity",
            message: "Could not refresh session activity and pending requests.",
          });
          return undefined;
        }
      };
      const statuses = await read("activity.status");
      const permissions = await read("activity.permissions");
      const questions = await read("catalog.questions");
      if (!this.#current(controller)) return;
      // Each native inventory qualifies only its own facts. A failed question
      // inventory cannot discard fresh status or permission evidence.
      if (statuses) {
        for (const id of this.#liveWork.keys()) {
          if (this.#index.getMetadata(id)?.directory === directory) {
            this.#liveWork.delete(id);
          }
        }
        await each(byDirectory.get(directory) ?? [], (entry) => {
          this.#liveWork.delete(entry.id);
          this.#idle.set(entry.id, this.#connection);
          entry.status = "idle";
          entry.retry = undefined;
        });
        await each(statuses, (status) => {
          if (status.status !== "idle") {
            this.#idle.delete(status.id);
            this.#liveWork.set(
              status.id,
              {
                key: `execution:${this.#connection}:${status.id}`,
                generation: this.#connection,
              },
            );
          } else this.#idle.set(status.id, this.#connection);
          routing.add(status.id);
          const entry = entries.get(status.id) ??
            this.#activityEntry(status.id, directory);
          entries.set(status.id, entry);
          entry.status = status.status;
          entry.retry = status.retry;
        });
      }
      if (permissions) {
        this.#permissionInventories.set(directory, this.#connection);
        await each(permissions, (request) => {
          void this.#errors.retainHistory(
            request.sessionID,
            `permission.observe:${request.id}`,
            () =>
              this.#retention.observe(
                request.sessionID,
                `permission:${request.id}`,
                { ...request },
                request.time,
              ),
          ).catch((error) =>
            this.diagnostic("warn", "pending permission history", error)
          );
          routing.add(request.sessionID);
          if (!entries.has(request.sessionID)) {
            entries.set(
              request.sessionID,
              this.#activityEntry(request.sessionID, directory),
            );
          }
          nextPermissions.set(
            request.id,
            {
              directory,
              generation: this.#connection,
              request: {
                ...request,
                time: previousPermissions.get(request.id)?.request.time ??
                  request.time,
              },
            },
          );
        });
      } else {
        await each(previousPermissions, ([id, pending]) => {
          if (pending.directory === directory) nextPermissions.set(id, pending);
        });
      }
      if (questions) {
        await each(questions, (request) => {
          routing.add(request.sessionID);
          if (!entries.has(request.sessionID)) {
            entries.set(
              request.sessionID,
              this.#activityEntry(request.sessionID, directory),
            );
          }
          nextQuestions.set(request.id, {
            request,
            directory,
            generation: this.#connection,
          });
        });
        knownQuestionDirectories.add(directory);
      } else {
        await each(this.#questions.values(), (pending) => {
          if (pending.directory === directory) {
            nextQuestions.set(pending.request.id, pending);
          }
        });
      }
      await each(byDirectory.get(directory) ?? [], (entry) => {
        entry.activityAuthority = statuses && permissions && questions
          ? "current"
          : "stale";
        if (!statuses) {
          const previous = this.#index.getMetadata(entry.id);
          if (previous) {
            entry.status = previous.status;
            entry.retry = previous.retry;
          }
        }
      });
    };
    const remaining = directories.values();
    await Promise.all(
      Array.from({ length: Math.min(1, directories.size) }, async () => {
        for (const directory of remaining) {
          if (!this.#current(controller)) return;
          await inventory(directory);
        }
      }),
    );
    if (!this.#current(controller)) return;
    if (seeds) {
      // Activity inventories identify real blocked/running work independently
      // of view demand. Acquire its routing ancestry before deriving family
      // counts; placeholder entries cannot establish family membership.
      const active = [...routing];
      await this.core.hydrate!(active, controller.signal);
      if (!this.#current(controller)) return;
      const family = function* (index: SessionIndex) {
        for (const id of active) {
          yield id;
          yield* index.ancestors(id);
        }
      };
      await each(family(this.#index), (id) => {
        const metadata = this.#index.getMetadata(id);
        if (!metadata) return;
        const activity = entries.get(id);
        entries.set(id, {
          ...metadata,
          status: activity?.status ?? "idle",
          retry: activity?.retry,
          activityAuthority: activity?.activityAuthority ?? "current",
        });
      });
    }
    this.#errors.reconcile(new Set(entries.keys()));
    await each(entries.values(), (entry) => {
      this.#errors.register(entry.id);
      this.#errorEntry(entry);
    });
    if (!this.#current(controller)) return;
    this.#permissions = nextPermissions;
    this.#questions.reset(nextQuestions.values(), knownQuestionDirectories);
    for (const id of this.#questionFresh.keys()) {
      if (!nextQuestions.has(id)) this.#questionFresh.delete(id);
    }
    for (const pending of nextQuestions.values()) {
      if (
        pending.directory && knownQuestionDirectories.has(pending.directory)
      ) {
        this.#questionFresh.set(pending.request.id, this.#connection);
      }
    }
    const permissions = function* () {
      for (const { request } of nextPermissions.values()) {
        yield request.sessionID;
      }
    };
    await each(
      this.#attention.reconcile(
        entries,
        permissions(),
        [...this.#questions.values()].map((pending) =>
          pending.request.sessionID
        ),
      ),
      () => {},
    );
    if (!this.#current(controller)) return;
    if (this.digest) {
      await each(entries.values(), (entry) => sink.indexUpsert(entry));
    } else sink.indexReset([...entries.values()]);
    if (this.digest) {
      this.#deliveries = new DeliveryBackfill(
        this.digest,
        (parent, updates, reset) => {
          if (
            !this.#current(controller) || connection !== this.#connection
          ) return;
          const dirty = new Set(updates.map((row) => row.id));
          if (reset) {
            for (const entry of this.#index.snapshotEntries()) {
              if (entry.parentID === parent) dirty.add(entry.id);
            }
          }
          this.#deliveryJoin?.request(dirty);
        },
        (error) =>
          this.diagnostic("warn", "delivery evidence unavailable", error),
      );
      const retainedParents = new Set(
        (this.#target.retainedSessions ?? []).flatMap((id) => {
          const parent = this.#index.getMetadata(id)?.parentID;
          return parent ? [parent] : [];
        }),
      );
      for (const parent of new Set([...retainedParents, ...terminalParents])) {
        this.#deliveries.request(parent);
      }
    }
    sink.projectAuthority?.(hints ? "current" : "unknown");
  }
  /** Scalar routing/activity facts for IDs outside the demanded metadata window. */
  #activityEntry(id: string, directory: string): IndexEntry {
    return this.#index.getMetadata(id) ?? {
      id,
      directory,
      projectID: "",
      title: "",
      timeCreated: 0,
      timeUpdated: 0,
      archived: false,
      status: "idle",
      activityAuthority: "current",
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
    };
  }
  #question(
    id: string,
    request?: import("@otk/protocol").QuestionRequest,
    directory?: string,
  ): void {
    if (request) {
      this.#questions.upsert(
        request,
        directory ?? this.#directory(request.sessionID),
      );
    } else this.#questions.remove(id);
  }
  #disposeSession(id: string): void {
    const sink = this.#sink;
    this.#liveWork.delete(id);
    this.#terminals.delete(id);
    this.#terminalCandidates.delete(id);
    this.#idle.delete(id);
    this.#abortCommands(id);
    this.#errors.remove(id);
    for (const [key, pending] of this.#permissions) {
      if (pending.request.sessionID !== id) continue;
      this.#permissions.delete(key);
      this.#attention.change(id, "permissions", -1);
      {
        sink.content(id, {
          op: "permission.remove",
          requestID: key,
          sessionID: id,
        });
      }
    }
    for (const { request } of this.#questions.values()) {
      if (request.sessionID !== id) continue;
      const key = request.id;
      this.#question(key);
      {
        sink.content(id, {
          op: "question.remove",
          requestID: key,
          sessionID: id,
        });
      }
    }
    this.#attention.dispose(id, !!this.digest);
    this.#tasks.dispose(id);
    this.#colors.release(id);
    this.#reverts.delete(id);
    this.#revertRecords.delete(id);
    this.#recovery.release(id);
    this.#clocks.release(id);
    this.#releaseRevert(id);
    this.buffers.removeSession(id);
    this.#selectionIntents.release(ids.decode(id));
    this.#transcript.release(id);
  }
  /** Read the shared metadata identity for an accepted native authority fact. */
  #metadata(id: string): IndexEntry | undefined {
    const entry = this.#index.getMetadata(id);
    if (!entry) return;
    const { deleted: _deleted, ...metadata } = entry;
    return metadata;
  }
  /** End native ownership while retaining the authoritative metadata identity. */
  retireSession(id: string): void {
    this.#retired.add(id);
    this.#disposeSession(id);
    const entry = this.#index.getMetadata(id);
    if (entry) {
      entry.status = "idle";
      delete entry.retry;
      entry.attention = {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      };
      this.#sink.indexUpsert(entry);
    }
  }
  restoreSession(id: string): void {
    this.#retired.delete(id);
  }
  async #handle(event: Envelope, controller: AbortController): Promise<void> {
    try {
      await this.#event(event, controller);
    } catch (error) {
      if (this.#current(controller)) {
        this.diagnostic("warn", `harness event ${event.payload?.type}`, error);
      }
    }
  }
  async #event(event: Envelope, controller: AbortController): Promise<void> {
    if (!this.#current(controller)) return;
    const sink = this.#sink;
    const { type, properties: p } = event.payload;
    // The 1.x bridge emits both the legacy event and its durable "sync"
    // companion. The latter has syncEvent, not properties; do not apply twice.
    if (!contentEvents.has(type)) {
      this.#ignored(type);
      return;
    }
    const catalogKinds = this.catalogs.event(event);
    if (catalogKinds) {
      if (catalogKinds.includes("agents")) this.#colors.reset();
      if (catalogKinds.includes("project") && this.digest?.projects) {
        const seeds = await this.digest.projects(
          this.#connection,
          controller.signal,
        );
        if (this.#current(controller)) sink.projectSeeds?.(seeds.projects);
      }
      return;
    }
    if (!p) throw new Error(`Malformed ${type} event: properties missing`);
    const nativeID = (type.startsWith("session.") &&
        ["session.created", "session.updated", "session.deleted"].includes(
          type,
        ))
      ? (p.info as Session)?.id
      : p.sessionID ?? (p.info as Info)?.sessionID ??
        (p.part as RawPart)?.sessionID;
    if (typeof nativeID === "string" && type.startsWith("message.")) {
      this.#transcript.changed(ids.encode(nativeID));
    }
    if (this.digest && typeof nativeID === "string") {
      const id = ids.encode(nativeID), revision = ++this.#digestRevision;
      if (type === "session.deleted") {
        this.#retired.add(id);
        this.#selectionIntents.release(nativeID);
        this.#clocks.release(id);
        this.#releaseRevert(id);
        const metadata = this.#metadata(id) ?? mapIndex(p.info as Session);
        void this.digest.deleted(this.#connection, id, revision, metadata)
          .catch((
            error,
          ) => this.diagnostic("warn", "digest deletion", error));
      } else if (
        [
          "session.created",
          "session.updated",
          "message.updated",
          "message.removed",
          "message.part.updated",
          "message.part.removed",
          "session.status",
          "session.idle",
          "session.error",
          "permission.asked",
          "question.asked",
        ].includes(type)
      ) {
        this.digest.observe(this.#connection, [{
          sessionID: id,
          ...(event.directory
            ? {
              metadata: {
                ...(type === "session.created" || type === "session.updated"
                  ? mapIndex(p.info as Session)
                  : this.#activityEntry(id, event.directory)),
                status: "idle" as const,
                retry: undefined,
                attention: {
                  permissions: 0,
                  questions: 0,
                  childPermissions: 0,
                  childQuestions: 0,
                },
              },
            }
            : {}),
          revision,
          reason: type === "session.created" || type === "session.updated"
            ? "metadata"
            : type.startsWith("message.")
            ? "messages"
            : "attention",
          ...(type === "message.updated"
            ? { messages: [(p.info as Info).id] }
            : type === "message.removed"
            ? { messages: [String(p.messageID)] }
            : type.startsWith("message.part.")
            ? {
              messages: [String((p.part as RawPart)?.messageID ?? p.messageID)],
            }
            : {}),
        }]);
      }
      if (
        [
          "message.updated",
          "message.removed",
          "message.part.updated",
          "message.part.removed",
        ].includes(type) &&
        (this.#index.getMetadata(id)?.parentID || this.#index.helper(id))
      ) {
        this.digest.observe(this.#connection, [{
          sessionID: id,
          revision,
          reason: "helper",
          messages: [
            String(
              p.messageID ?? (p.info as Info)?.id ??
                (p.part as RawPart)?.messageID ?? "",
            ),
          ],
        }]);
      }
    }
    if (type === "server.instance.disposed") {
      this.buffers.reset();
      this.#transcript.invalidate();
      this.#abortCommands();
      this.#errors.reset();
      this.#questions.uncertain();
      this.catalogs.reset(event.directory);
      this.#colors.reset();
      try {
        await this.#bootstrap(controller);
      } catch (error) {
        // A failed authoritative bootstrap remains a connection-level failure.
        controller.abort();
        throw error;
      }
      if (this.#current(controller)) sink.bootstrapComplete();
      return;
    }
    const info = p.info as Info | undefined;
    const raw = p.part as RawPart | undefined;
    const sessionID = typeof nativeID === "string" ? ids.encode(nativeID) : "";
    if (
      sessionID &&
      (type === "message.part.updated" && raw &&
          (raw.tool === "task" && raw.state?.status === "completed" ||
            raw.type === "text" && raw.synthetic) ||
        type === "message.part.removed" || type === "message.removed" ||
        type === "session.updated")
    ) this.#deliveries?.request(sessionID, true);
    if (sessionID) {
      const turn = this.#failureTurns.get(sessionID) ?? {};
      if (info?.time?.created !== undefined) {
        turn.created = Math.max(turn.created ?? 0, info.time.created);
      }
      if (type === "message.updated" && info?.role === "user") {
        if (turn.candidate !== info.id) {
          this.#failureAttempts.retire(sessionID);
          turn.prompt = undefined;
        }
        turn.candidate = info.id;
      }
      if (
        type === "message.updated" && info?.role === "assistant" &&
        info.parentID
      ) turn.prompt = info.parentID;
      if (raw && raw.messageID === turn.candidate && isPromptPart(raw)) {
        turn.prompt = raw.messageID;
      }
      if (turn.candidate || turn.prompt) {
        this.#failureTurns.set(sessionID, turn);
      }
      if (type === "session.deleted") {
        this.#failureTurns.delete(sessionID);
        this.#failureAttempts.remove(sessionID);
      }
    }
    if (
      sessionID && this.digest?.projects &&
      (type === "permission.asked" || type === "question.asked")
    ) {
      // Pending input is mandatory demand even when no view has acquired the
      // asking session. Use the same keyed routing owner as cold inventory.
      try {
        await this.core.hydrate!([sessionID], controller.signal);
      } catch (error) {
        if (!this.#current(controller)) return;
        // Unavailable routing cannot discard an authoritative received request.
        // Retain its direct attention/actions while native metadata recovers.
        this.diagnostic("warn", "pending input routing", error);
      }
      if (!this.#current(controller)) return;
    }
    let entry = this.#index.getMetadata(sessionID);
    if (
      !entry && sessionID && event.directory &&
      [
        "session.status",
        "session.idle",
        "session.error",
        "permission.asked",
        "question.asked",
      ].includes(type)
    ) {
      entry = this.#activityEntry(sessionID, event.directory);
      sink.indexUpsert(entry);
    }
    if (
      (entry?.deleted || this.#retired.has(sessionID)) &&
      type !== "session.created" && type !== "session.updated" &&
      type !== "session.deleted"
    ) return;
    if (type === "session.created" || type === "session.updated") {
      this.#catalogExecutor?.invalidateSessionLists();
      if (typeof info?.id !== "string" || !info.id) {
        throw new Error(`Malformed ${type}: session id missing`);
      }
      const session = p.info as Session,
        mapped = mapIndex(session),
        old = this.#index.getMetadata(mapped.id);
      const previousCutoff = this.#reverts.get(mapped.id);
      this.#transcript.observe(session);
      this.#errors.register(mapped.id);
      if (old) {
        mapped.status = old.status;
        mapped.retry = old.retry;
        mapped.attention = old.attention;
      }
      this.#errorEntry(mapped);
      this.#attention.upsert(mapped);
      if (type === "session.created" && this.digest?.projects) {
        const seeds = await this.digest.projects(
          this.#connection,
          controller.signal,
          undefined,
          mapped.directory,
        );
        if (this.#current(controller)) sink.projectSeeds?.(seeds.projects);
      }
      if (
        this.buffers.subscribed(mapped.id) &&
        (session.revert || previousCutoff) &&
        previousCutoff !== session.revert?.messageID
      ) {
        // Cutoff authority is synchronous; only its optional presentation waits.
        this.#releaseRevert(mapped.id);
        if (session.revert) {
          this.#reverts.set(mapped.id, session.revert.messageID);
          this.#tasks.cutoff(mapped.id, session.revert.messageID);
        } else {
          this.#reverts.delete(mapped.id);
          this.#revertRecords.delete(mapped.id);
        }
        const local = new AbortController();
        this.#revertReads.set(mapped.id, local);
        const signal = AbortSignal.any([controller.signal, local.signal]);
        const epoch = this.#replay.clock(mapped.id).epoch;
        void this.#revertInfo(session, signal, "visible").then((revert) => {
          if (
            signal.aborted || !this.#current(controller) ||
            !this.buffers.subscribed(mapped.id) ||
            this.#replay.clock(mapped.id).epoch !== epoch ||
            this.#revertReads.get(mapped.id) !== local
          ) return;
          sink.content(mapped.id, {
            op: "session.revert",
            boundaryID: revert?.boundaryID,
            messageIDs: revert?.messageIDs ?? [],
            files: revert?.files || [],
            prompt: revert?.prompt,
          });
        }).catch((error) => {
          if (!signal.aborted) {
            this.diagnostic("warn", "revert enrichment", error);
          }
        }).finally(() => {
          if (this.#revertReads.get(mapped.id) === local) {
            this.#revertReads.delete(mapped.id);
          }
        });
      }
      return;
    }
    if (type === "session.deleted") {
      const id = (p.info as Session).id;
      if (typeof id !== "string" || !id) {
        throw new Error("Malformed session.deleted: session id missing");
      }
      this.#disposeSession(ids.encode(id));
      this.#retention.remove(ids.encode(id));
      if (this.digest?.projects) {
        const seeds = await this.digest.projects(
          this.#connection,
          controller.signal,
          undefined,
          (p.info as Session).directory,
        );
        if (this.#current(controller)) sink.projectSeeds?.(seeds.projects);
      }
      return;
    }
    if (!sessionID) throw new Error(`Malformed ${type}: session id missing`);
    if (type === "session.status" || type === "session.idle") {
      const status: {
        type: IndexEntry["status"];
        attempt?: number;
        message?: string;
        next?: number;
        action?: Record<string, unknown>;
      } = type === "session.idle" ? { type: "idle" } : p.status as {
        type: IndexEntry["status"];
        attempt?: number;
        message?: string;
        next?: number;
      };
      if (!status || !["idle", "busy", "retry"].includes(status.type)) {
        throw new Error(`Malformed ${type}: invalid status`);
      }
      if (status.type === "retry") {
        const key = `retry:${
          event.payload.id ?? `${status.attempt}:${status.next}`
        }`;
        const previous = this.#retention.get(sessionID, key);
        const created = previous?.created ?? Date.now();
        const message = eventRecord(
          ids.decode(sessionID),
          key,
          created,
          "session.retry",
          status,
        );
        this.#retention.put({ id: key, sessionID, created, message });
        if (this.buffers.subscribed(sessionID)) {
          sink.content(sessionID, {
            op: "message.upsert",
            message: recordReference(message),
          });
        }
      }
      if (entry) {
        if (status.type === "idle") this.#idle.set(sessionID, this.#connection);
        else this.#idle.delete(sessionID);
        if (status.type === "idle") this.#liveWork.delete(sessionID);
        else if (
          this.#liveWork.get(sessionID)?.generation !== this.#connection
        ) {
          this.#liveWork.set(
            sessionID,
            {
              key: `execution:${this.#connection}:${sessionID}`,
              generation: this.#connection,
            },
          );
        }
        entry.status = status.type as IndexEntry["status"];
        entry.activityAuthority = "current";
        entry.retry = entry.status === "retry"
          ? {
            attempt: status.attempt!,
            message: status.message!,
            next: status.next!,
          }
          : undefined;
      }
      // Index reads are detached values: commit status before the error owner
      // publishes its independent clear observation against that same record.
      if (entry) sink.indexUpsert(entry);
      if (status.type === "busy") this.#errors.clear(sessionID);
      if (status.type === "idle") this.#recovery.terminal(sessionID);
      return;
    }
    if (type === "session.error") {
      if (!this.#errors.accepts(sessionID)) return;
      if (this.#failureAttempts.replay(sessionID, event.payload.id)) return;
      const error = p.error as Info["error"];
      // Native cancellation belongs to NT4's Interrupted record, not a failed
      // submission/execution. Keep its existing independent diagnostic channel.
      if (error?.name === "MessageAbortedError") {
        this.#failureAttempts.retire(sessionID);
        this.#errors.native(sessionID, {
          message: error.data?.message || "Execution interrupted.",
          kind: error.name,
        }, event.payload.id);
        return;
      }
      const failure = {
        code: "native.execution",
        retry: "none" as const,
        diagnosticID: this.#failureTurns.get(sessionID)?.prompt
          ? `execution:${this.#failureTurns.get(sessionID)!.prompt}`
          : event.payload.id
          ? `execution:${event.payload.id}`
          : crypto.randomUUID(),
        facts: {
          ...this.client.failureFacts(error),
          actionLabel: "Running session",
          origin: this.#failureAttempts.origin(sessionID) ??
            this.#retention.get(
              sessionID,
              `submission:${this.#failureTurns.get(sessionID)?.prompt}`,
            )?.request?.origin as
              | import("@otk/protocol").RequestOrigin
              | undefined,
          target: { sessionID, label: entry?.title },
          outcome: "rejected" as const,
        },
      };
      const recordID = this.#failureAttempts.native(
        sessionID,
        failure.facts.reason ?? "Native operation failed",
        `request:failure:${failure.diagnosticID}`,
        event.payload.id,
      );
      const message = requestFailureRecord(
        sessionID,
        failure,
        this.#failureCreated(sessionID, recordID),
        this.#failureTurns.get(sessionID)?.prompt,
        recordID,
      );
      const previous = this.#retention.get(sessionID, message.id);
      const priorPart = previous?.message?.parts.find((part) =>
        part.kind === "external" && part.failure
      );
      const priorFailure = priorPart?.kind === "external"
        ? priorPart.failure
        : undefined;
      const priorReason = priorFailure?.facts?.reason,
        nextReason = failure.facts.reason;
      // Stock getModel and promptAsync report the same failed turn twice. The
      // native cause stays diagnostic; identical readable facts enrich one row.
      const reason = priorReason && nextReason?.includes(priorReason)
        ? priorReason
        : [...new Set([priorReason, nextReason].filter(Boolean))].join("\n");
      const retained = requestFailureRecord(
        sessionID,
        {
          ...failure,
          diagnosticID: priorFailure?.diagnosticID ?? failure.diagnosticID,
          facts: {
            ...priorFailure?.facts,
            ...failure.facts,
            origin: priorFailure?.facts?.origin ?? failure.facts.origin,
            reason,
          },
        },
        previous?.created ?? message.time.created,
        previous?.message ? previous.message.replyTo : message.replyTo,
        recordID,
      );
      const retainedPart = retained.parts[0];
      const retainedFailure = retainedPart.kind === "external"
        ? retainedPart.failure
        : undefined;
      this.#retention.put({
        id: message.id,
        sessionID,
        created: previous?.created ?? message.time.created,
        message: retained,
      });
      if (this.buffers.subscribed(sessionID)) {
        sink.content(sessionID, {
          op: "message.upsert",
          message: retained,
        });
      }
      this.#errors.native(sessionID, {
        failure: retainedFailure,
        message: failure.facts.reason ?? "Native operation failed",
        ...(error?.name ? { kind: error.name } : {}),
        ...(error?.data?.ref ? { ref: error.data.ref } : {}),
      }, event.payload.id);
      return;
    }
    if (type === "permission.asked") {
      const request = p as unknown as RawPermission;
      if (typeof request.id !== "string" || !request.id) {
        throw new Error("Malformed permission.asked: request id missing");
      }
      const time = this.#permissions.get(request.id)?.request.time ??
        Date.now();
      const mapped = mapPermission(request, time);
      const previous = this.#permissions.get(request.id)?.request.sessionID;
      this.#permissions.set(request.id, {
        request: mapped,
        directory: event.directory,
        generation: this.#connection,
      });
      if (previous !== sessionID) {
        if (previous) this.#attention.change(previous, "permissions", -1);
        this.#attention.change(sessionID, "permissions", 1);
      } else if (entry) {
        // Changed request metadata must wake the same server index observer even
        // when the number of pending requests did not change.
        sink.indexUpsert(entry);
      }
      sink.content(sessionID, {
        op: "permission.upsert",
        request: mapped,
      });
      await this.#errors.retainHistory(
        sessionID,
        `permission.ask:${request.id}`,
        () =>
          this.#retention.observe(
            sessionID,
            `permission:${request.id}`,
            p,
            time,
            true,
          ),
      );
      return;
    }
    if (type === "permission.replied") {
      const previous = this.#permissions.get(String(p.requestID));
      this.#permissions.delete(String(p.requestID));
      if (previous) {
        this.#attention.change(previous.request.sessionID, "permissions", -1);
      }
      sink.content(sessionID, {
        op: "permission.remove",
        requestID: String(p.requestID),
        sessionID,
      });
      const key = `permission:${String(p.requestID)}`;
      await this.#errors.retainHistory(sessionID, key, () => {
        const retained = this.#retention.get(sessionID, key);
        const created = retained?.created ?? Date.now();
        const message = eventRecord(
          ids.decode(sessionID),
          key,
          created,
          type,
          p,
          retained?.request,
        );
        this.#retention.put({
          id: key,
          sessionID,
          created,
          request: retained?.request,
          message,
        });
        if (this.buffers.subscribed(sessionID)) {
          sink.content(sessionID, {
            op: "message.upsert",
            message: recordReference(message),
          });
        }
      });
      return;
    }
    if (type === "question.asked") {
      if (typeof p.id !== "string" || !p.id) {
        throw new Error("Malformed question.asked: request id missing");
      }
      const request = mapQuestion(p as unknown as RawQuestion);
      this.#question(String(p.id), request, event.directory);
      sink.content(sessionID, {
        op: "question.upsert",
        request,
      });
      const created = Date.now();
      await this.#errors.retainHistory(
        sessionID,
        `question.ask:${String(p.id)}`,
        () =>
          this.#retention.observe(
            sessionID,
            `question:${String(p.id)}`,
            p,
            created,
            true,
          ),
      );
      return;
    }
    if (type === "question.replied" || type === "question.rejected") {
      this.#question(String(p.requestID));
      sink.content(sessionID, {
        op: "question.remove",
        requestID: String(p.requestID),
        sessionID,
      });
      const key = `question:${String(p.requestID)}`;
      await this.#errors.retainHistory(sessionID, key, () => {
        const retained = this.#retention.get(sessionID, key);
        const created = retained?.created ?? Date.now();
        const message = eventRecord(
          ids.decode(sessionID),
          key,
          created,
          type,
          p,
          retained?.request,
        );
        this.#retention.put({
          id: key,
          sessionID,
          created,
          request: retained?.request,
          message,
        });
        if (this.buffers.subscribed(sessionID)) {
          sink.content(sessionID, {
            op: "message.upsert",
            message: recordReference(message),
          });
        }
      });
      return;
    }
    if (
      type === "message.updated" && info?.role === "assistant" &&
      !assistantSettled(info)
    ) this.buffers.beginReply(sessionID, info.id);
    const completedOutput =
      type === "message.updated" && info?.role === "assistant" &&
        assistantSettled(info)
        ? this.buffers.outputEnd(info.id)
        : undefined;
    if (
      type === "message.updated" && info?.role === "assistant" &&
      assistantSettled(info)
    ) {
      this.buffers.complete(info.id, (id, op) => {
        sink.content(id, op);
      });
    }
    if (
      type === "message.updated" && info?.role === "assistant" &&
      assistantSettled(info)
    ) {
      this.#recovery.checkpoint(
        sessionID,
        info.id,
        String(++this.#recoveryRevision),
      );
      this.#recovery.terminal(sessionID, info.id);
    } else if (type === "message.updated" && info) {
      this.#recovery.checkpoint(
        sessionID,
        info.id,
        String(++this.#recoveryRevision),
      );
    }
    if (type === "message.updated" && info) {
      this.#clocks.release(sessionID, info.id);
    }
    if (type === "message.part.delta") {
      this.#clocks.release(sessionID, String(p.messageID));
    }
    if (
      type === "message.updated" && info?.role === "assistant" &&
      terminalToken(info) > 0
    ) {
      this.#terminalCandidates.set(
        sessionID,
        latestTerminal(
          this.#terminalCandidates.get(sessionID),
          { ...terminalFacts(info), terminalOrigin: "live" },
        ),
      );
      const parent = this.#index.getMetadata(sessionID)?.parentID;
      if (parent) this.#deliveries?.request(parent, true);
      const current = this.#index.getMetadata(sessionID);
      if (current) {
        current.timeUpdated = Math.max(
          current.timeUpdated,
          terminalToken(info),
        );
        sink.indexUpsert(current);
      }
    }
    if (type === "message.removed") {
      this.#records.remove(ids.decode(sessionID), String(p.messageID));
      this.#clocks.release(sessionID, String(p.messageID));
      this.#selectionIntents.release(ids.decode(sessionID));
      this.#recovery.message(String(p.messageID), sessionID);
      this.buffers.removeMessage(String(p.messageID));
    }
    if (type === "message.part.removed") {
      this.#records.remove(
        ids.decode(sessionID),
        String(p.messageID),
        String(p.partID),
      );
      this.#clocks.release(sessionID, String(p.messageID));
      this.#recovery.part(String(p.messageID), String(p.partID), sessionID);
      this.buffers.forgetPart(String(p.messageID), String(p.partID));
    }
    if (type === "message.part.updated" && raw && raw.tool !== "task") {
      this.#tasks.remove(sessionID, raw.messageID, raw.id);
    }
    const record = type === "message.part.updated" && raw &&
        this.buffers.subscribed(sessionID)
      ? this.#records.part(raw)
      : undefined;
    let finishedPart: Part | undefined;
    if (type === "message.part.updated" && raw) {
      this.#clocks.release(sessionID, raw.messageID);
      if (this.buffers.subscribed(sessionID)) {
        this.buffers.epoch(sessionID, this.#replay.clock(sessionID).epoch);
      }
      this.#recovery.part(raw.messageID, raw.id, sessionID);
      if (
        raw.type === "tool" ||
        ((raw.type === "text" || raw.type === "reasoning") &&
          raw.time?.start !== undefined)
      ) {
        this.buffers.observeOutput(
          sessionID,
          raw.messageID,
          Date.now(),
          raw.type === "tool" ? raw.state?.time?.end : raw.time?.end,
          raw.id,
        );
      }
      if (
        (raw.type === "text" || raw.type === "reasoning") &&
        !raw.synthetic && record?.info.role !== "user" &&
        !record?.info.summary &&
        raw.time?.start !== undefined && raw.time.end === undefined
      ) {
        this.buffers.upsert(
          sessionID,
          raw.messageID,
          mapStreamingShell(raw),
          raw.text || "",
        );
        if (
          this.buffers.snapshot(raw.id, sessionID, raw.messageID)?.part.stream
            ?.recovering
        ) {
          this.#recovery.touch(sessionID, raw.messageID, raw.id);
        }
      } else if (
        (raw.type === "text" || raw.type === "reasoning") &&
        !raw.synthetic && record?.info.role !== "user" &&
        !record?.info.summary &&
        raw.time?.end !== undefined
      ) {
        if (this.buffers.subscribed(sessionID)) {
          finishedPart = this.buffers.finishPart(
            sessionID,
            raw.messageID,
            mapStreamingShell(raw),
            raw.text || "",
          );
        } else this.buffers.remove(raw.id);
      } else this.buffers.remove(raw.id);
    }
    if (
      type === "message.part.delta" && p.field === "text" &&
      !this.#records.get(ids.decode(sessionID), String(p.messageID))?.parts
        .some((part) =>
          part.id === p.partID && (part.synthetic || part.time === undefined)
        ) &&
      this.buffers.append(
        String(p.partID),
        String(p.delta),
        (id, op) => {
          sink.content(id, op);
        },
      )
    ) return;
    if (type === "message.removed") {
      this.#tasks.remove(sessionID, String(p.messageID));
    }
    if (type === "message.part.removed") {
      this.#tasks.remove(sessionID, String(p.messageID), String(p.partID));
    }
    if (!this.buffers.subscribed(sessionID)) return;
    const cutoff = this.#reverts.get(sessionID),
      messageID = info?.id || raw?.messageID || String(p.messageID || "");
    if (cutoff && messageID && messageID >= cutoff) return;
    const content = (op: ContentOp) => {
      if (this.#current(controller) && this.buffers.subscribed(sessionID)) {
        sink.content(sessionID, op);
      }
    };
    switch (type) {
      case "message.updated":
        {
          this.#selectionIntents.header(info!);
          const native = this.#records.header(info!);
          const message = mapMessage(
              info!,
              info!.role === "user" || info!.summary ? native.parts : [],
              completedOutput ?? this.buffers.outputTime(info!.id),
            ),
            colors = this.#colors.peek(this.#directory(sessionID), sessionID);
          if (!this.#current(controller)) return;
          if (message.role !== "context" && message.agent !== undefined) {
            message.agentColor = colors?.get(message.agent);
          }
          const boundaries = message.role === "assistant" ? message.parts : [];
          content({
            op: "message.upsert",
            message: message.role === "assistant"
              ? { ...message, parts: [] }
              : message,
          });
          for (const part of boundaries) {
            content({ op: "part.upsert", messageID: message.id, part });
          }
          if (
            message.role === "assistant" &&
            isAssistantTerminal(message) &&
            completedOutput === undefined &&
            !this.#recovery.scoped(sessionID) &&
            !this.#recovery.snapshot(sessionID).some((p) =>
              p.messageID === message.id
            )
          ) {
            const epoch = this.#replay.clock(sessionID).epoch;
            const messageID = message.id;
            this.#clocks.request(
              sessionID,
              messageID,
              controller.signal,
              (lastOutput) => {
                if (
                  this.#current(controller) &&
                  this.buffers.subscribed(sessionID) &&
                  this.#replay.clock(sessionID).epoch === epoch
                ) {
                  content({
                    op: "message.clock",
                    messageID,
                    lastOutput,
                  });
                }
              },
            );
          }
        }
        break;
      case "message.removed":
        content({ op: "message.remove", messageID: String(p.messageID) });
        break;
      case "message.part.updated": {
        if (!raw) break;
        // Every live part reaches the selection owner, including the synthetic
        // approval part inside plan_exit's agent-bearing user record.
        const intent = this.#selectionIntents.part(raw);
        if (record && (record.info.role === "user" || record.info.summary)) {
          content({
            op: "message.upsert",
            message: mapMessage(record.info, record.parts),
          });
          break;
        }
        const part = finishedPart ||
          this.buffers.snapshot(raw.id, sessionID, raw.messageID)?.part ||
          mapPart(raw);
        if (part.kind === "tool" && intent) part.call.selectionIntent = intent;
        if (part.kind === "tool" && raw.tool === "task") {
          part.call = this.#tasks.shape(raw);
          referencePart(part, raw.messageID);
          if (!this.#current(controller)) return;
        }
        const lastOutput = this.buffers.outputTime(raw.messageID);
        content({
          op: "part.upsert",
          messageID: raw.messageID,
          part,
          ...(lastOutput === undefined ? {} : { lastOutput }),
        });
        break;
      }
      case "message.part.delta": {
        const id = String(p.partID);
        const changed = this.#records.delta(
          ids.decode(sessionID),
          String(p.messageID),
          id,
          String(p.field),
          String(p.delta),
        );
        if (changed) {
          const { message: record, part: raw } = changed;
          if (record.info.role === "user" || record.info.summary) {
            content({
              op: "message.upsert",
              message: mapMessage(record.info, record.parts),
            });
          } else {content({
              op: "part.upsert",
              messageID: raw.messageID,
              part: mapPart(raw),
            });}
          break;
        }
        if (
          p.field !== "text" || !this.buffers.append(
            id,
            String(p.delta),
            (id, op) => {
              sink.content(id, op);
            },
          )
        ) {
          this.#recovery.touch(sessionID, String(p.messageID), id);
        }
        break;
      }
      case "message.part.removed":
        this.buffers.remove(String(p.partID));
        content({
          op: "part.remove",
          messageID: String(p.messageID),
          partID: String(p.partID),
        });
        {
          const record = this.#records.get(
            ids.decode(sessionID),
            String(p.messageID),
          );
          if (record && (record.info.role === "user" || record.info.summary)) {
            content({
              op: "message.upsert",
              message: mapMessage(record.info, record.parts),
            });
          }
        }
        break;
      case "todo.updated":
        content({
          op: "todo.set",
          items: (p.todos as Todo[]).map((todo) => ({
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
          })),
        });
        break;
      case "session.diff":
        content({ op: "diff.set", files: mapDiffs(p.diff as RawDiff[]) });
        break;
      default:
        this.#ignored(type);
    }
  }
}
