// SPDX-License-Identifier: LGPL-3.0-only
import {
  type DiagnosticSink,
  errorMessage,
  isAttentionOp,
  isCancellation,
  normalizeError,
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
import { SessionErrors } from "./errors.ts";
import { sessionErrorMessage, type SessionErrorState } from "@otk/protocol";
import { BootstrapDb } from "./db.ts";
import { History } from "./history.ts";
import { consumeEvents } from "./events.ts";
import {
  mapDiffs,
  mapIndex,
  mapMessage,
  mapPart,
  mapSession,
  mapStreamingShell,
} from "./map.ts";
import { MessageClocks } from "./message-clocks.ts";
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
import {
  restore,
  revert,
  REVERT_PROMPT_LIMIT,
  revertPreview,
} from "./revert.ts";
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
        // A point read may discover the header for the first time. Publish it
        // before its parts; HTTP observations never advance native output clocks.
        const message = mapMessage(
          snapshot.info,
          [],
          messageOutput(snapshot.parts).lastOutput ?? undefined,
        );
        if (snapshot.info.time.completed !== undefined) {
          this.buffers.removeMessage(snapshot.info.id, session);
        }
        this.#sink.content(session, {
          op: "message.upsert",
          message: { ...message, parts: [] },
        });
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
            snapshot.info.time.completed === undefined &&
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
        if (!terminal && snapshot.info.time.completed !== undefined) {
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
        if (id === undefined) this.#selectionIntents.clear();
        else this.#selectionIntents.release(ids.decode(id));
        this.#releaseRevert(id);
      },
      recovering: (id) => this.#recovery.snapshot(id),
      scopedRecovery: (id) => this.#recovery.scoped(id),
      retryRecovery: (id) => this.#recovery.retry(id),
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
        const revert = await this.#revertInfo(raw, signal),
          errorState = this.#errors.snapshot(ids.encode(raw.id));
        return {
          ...mapSession(raw),
          revert,
          error: sessionErrorMessage(errorState),
          errorState,
        };
      },
      metadata: digest
        ? (id, turns, signal, cutoff, boundary) =>
          digest.transcriptMetadata(id, turns, signal, cutoff, boundary)
        : undefined,
      decorate: (message, raw, directory) => {
        const colors = this.#colors.peek(
          directory,
          this.buffers.subscribed(message.sessionID)
            ? message.sessionID
            : undefined,
        );
        if (message.agent !== undefined) {
          message.agentColor = colors?.get(message.agent);
        }
        for (const [i, part] of raw.parts.entries()) {
          if (part.type === "tool" && part.tool === "task") {
            message.parts[i] = {
              kind: "tool",
              id: part.id,
              call: this.#tasks.shape(part),
            };
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
      prompt(this.client, directory, (id) => {
        this.#abortCommands(id);
        this.#errors.cancel(id);
      }, cfg.attachments),
    );
    registry.register("shell", shell(this.client, directory, launch));
    registry.register(
      "commands",
      commands(this.client, directory, launch, this.catalogs, cfg.attachments),
    );
    registry.register("history", this.#history);
    registry.register("catalogs", {
      watch: (directory, listener, signal) => {
        signal.throwIfAborted();
        const lease = this.catalogs.acquire(directory);
        const stop = lease.subscribe(() => listener(lease.snapshot()));
        const release = () => {
          stop();
          lease.release();
        };
        signal.addEventListener("abort", release, { once: true });
        const value = lease.snapshot();
        for (
          const kind of Object.keys(
            value.values,
          ) as (keyof import("@otk/protocol").DirectoryCatalogKinds)[]
        ) {
          void lease.get(kind).catch(
            () => {/* shared resource publishes unavailable */},
          );
        }
        queueMicrotask(() => {
          if (!signal.aborted) listener(lease.snapshot());
        });
        return Promise.resolve(value);
      },
      refresh: async (directory, signal) => {
        signal?.throwIfAborted();
        const lease = this.catalogs.acquire(directory);
        try {
          await lease.refresh();
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
    return connectionPublication({
      ...this.#target,
      content: (id, event) => {
        if (isAttentionOp(event)) this.#target.content(id, event);
        else this.#replay.publish(id, event);
      },
    }, signal);
  }
  async #shutdown(): Promise<void> {
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
    this.#selectionIntents.clear();
    this.#reverts.clear();
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
      return;
    }
    if (this.buffers.subscribed(id)) {
      this.#reverts.set(id, session.revert.messageID);
      this.#tasks.cutoff(id, session.revert.messageID);
    }
    let messageCount = this.#db.revertedUserCount(
      id,
      session.revert.messageID,
    );
    const projected = this.#db.revertedPrompts(
      id,
      session.revert.messageID,
      REVERT_PROMPT_LIMIT,
    );
    let prompt: import("@otk/protocol").HistoryEntry | undefined;
    try {
      prompt = await this.#history.entry(
        id,
        session.revert.messageID,
        signal,
        priority,
      );
    } catch (error) {
      signal?.throwIfAborted();
      // An unavailable native DB retains the existing API fallback boundary.
      if (messageCount !== undefined && projected) throw error;
    }
    let prompts = projected?.map(({ text, ...row }) => ({
      ...row,
      preview: revertPreview(text),
    }));
    if (messageCount === undefined || !prompts) {
      messageCount = 0;
      const bounded: NonNullable<RevertInfo["prompts"]> = [];
      let boundary: import("./messages.ts").NativeMessage | undefined;
      let command: string | undefined;
      for await (
        const message of this.#messages.scan(id, session.directory, signal)
      ) {
        if (
          message.info.role === "assistant" &&
          message.info.parentID === session.revert.messageID
        ) {
          const input = message.parts.find((p) =>
            p.type === "tool" && p.tool === "bash"
          )?.state?.input.command;
          if (typeof input === "string") command = input;
        }
        if (
          message.info.role === "user" &&
          message.info.id >= session.revert.messageID
        ) {
          messageCount++;
          const text = message.parts.find((p) =>
            p.type === "text" && !p.synthetic
          )?.text ?? (message.parts.filter((p) =>
            p.type === "file"
          ).map((p) => p.filename ?? "attachment").join(", ") ||
            (message.parts.some((p) =>
                p.type === "compaction"
              )
              ? "Compacted conversation"
              : ""));
          bounded.push({
            messageID: message.info.id,
            time: message.info.time.created,
            preview: revertPreview(text),
          });
          bounded.sort((a, b) => a.messageID.localeCompare(b.messageID));
          if (bounded.length > REVERT_PROMPT_LIMIT) bounded.pop();
          if (message.info.id === session.revert.messageID) boundary = message;
        }
      }
      prompts = bounded;
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
    const files = session.revert.diff
      ? parseDiff(session.revert.diff)
      : mapDiffs(session.summary?.diffs || []);
    return {
      messageID: session.revert.messageID,
      messageCount,
      prompts,
      prompt,
      files: files.map(({ path, additions, deletions }) => ({
        path,
        additions,
        deletions,
      })),
    };
  }
  #launch(
    sessionID: string,
    operation: Parameters<Launch>[1],
    path: string,
    options: Parameters<Client["request"]>[1],
  ): ReturnType<Launch> {
    if (this.#stopped) throw new HarnessError("stopped", "Harness is stopped");
    const controller = new AbortController();
    const token = this.#errors.begin(
      sessionID,
      operation,
      options?.operation?.key.key,
    );
    const settled = this.client.json(path, {
      ...options,
      signal: controller.signal,
      classification: "effect",
    }).then(() => {});
    const request = settled.then(() => this.#errors.settled(token)).catch(
      (error) => {
        if (!this.#stopped && !controller.signal.aborted) {
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
      this.#errors.settled(token);
      this.#commands.delete(controller);
    });
    this.#commands.set(controller, { sessionID, task: request });
    return { admitted: settled, settled };
  }
  #abortCommands(sessionID?: string): void {
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
    const routing = new Set<string>();
    const inventory = async (directory: string) => {
      const local = new AbortController();
      const signal = AbortSignal.any([controller.signal, local.signal]);
      const options = {
        owner: JSON.stringify(["activity", directory, this.#connection]),
        priority: "attention" as const,
        signal,
      };
      try {
        const statuses = await this.#catalogReads.read("activity.status", {
          directory,
        }, options);
        const permissions = await this.#catalogReads.read(
          "activity.permissions",
          { directory },
          options,
        );
        const questions = await this.#catalogReads.read("catalog.questions", {
          directory,
        }, options);
        if (!this.#current(controller)) return;
        // A complete inventory proves omitted sessions idle; unavailable
        // authority alone must retain their previous activity.
        await each(byDirectory.get(directory) ?? [], (entry) => {
          entry.status = "idle";
          entry.retry = undefined;
        });
        await each(statuses, (status) => {
          routing.add(status.id);
          const entry = entries.get(status.id) ??
            this.#activityEntry(status.id, directory);
          entries.set(status.id, entry);
          entry.status = status.status;
          entry.retry = status.retry;
        });
        await each(permissions, (request) => {
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
              request: {
                ...request,
                time: previousPermissions.get(request.id)?.request.time ??
                  request.time,
              },
            },
          );
        });
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
        await each(byDirectory.get(directory) ?? [], (entry) => {
          entry.activityAuthority = "current";
        });
      } catch (error) {
        if (!this.#current(controller)) return;
        this.diagnostic(
          "warn",
          `bootstrap directory ${JSON.stringify(directory)}`,
          error,
        );
        // A failed inventory is not evidence that previous work/input ended.
        await each(byDirectory.get(directory) ?? [], (entry) => {
          entry.activityAuthority = "stale";
          const previous = this.#index.getMetadata(entry.id);
          if (previous) {
            entry.status = previous.status;
            entry.retry = previous.retry;
          }
        });
        await each(previousPermissions, ([id, pending]) => {
          if (pending.directory === directory) nextPermissions.set(id, pending);
        });
        await each(this.#questions.values(), (pending) => {
          if (pending.directory === directory) {
            nextQuestions.set(pending.request.id, pending);
          }
        });
      }
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
    this.#abortCommands(id);
    this.#errors.remove(id);
    for (const [key, pending] of this.#permissions) {
      if (pending.request.sessionID !== id) continue;
      this.#permissions.delete(key);
      this.#attention.change(id, "permissions", -1);
      if (!this.digest) {
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
      if (!this.digest) {
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
    const identity = p.sessionID ?? info?.sessionID ?? raw?.sessionID;
    const sessionID = typeof identity === "string" ? ids.encode(identity) : "";
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
        } else this.#reverts.delete(mapped.id);
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
            messageID: revert?.messageID,
            messageCount: revert?.messageCount || 0,
            files: revert?.files || [],
            prompts: revert?.prompts,
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
      if (!this.digest) this.#disposeSession(ids.encode(id));
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
      } = type === "session.idle" ? { type: "idle" } : p.status as {
        type: IndexEntry["status"];
        attempt?: number;
        message?: string;
        next?: number;
      };
      if (!status || !["idle", "busy", "retry"].includes(status.type)) {
        throw new Error(`Malformed ${type}: invalid status`);
      }
      if (entry) {
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
      const error = p.error as Info["error"];
      this.#errors.native(sessionID, {
        message: error?.data?.message || "Harness error",
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
      return;
    }
    if (type === "question.replied" || type === "question.rejected") {
      this.#question(String(p.requestID));
      sink.content(sessionID, {
        op: "question.remove",
        requestID: String(p.requestID),
        sessionID,
      });
      return;
    }
    if (
      type === "message.updated" && info?.role === "assistant" &&
      info.time.completed === undefined
    ) this.buffers.beginReply(sessionID, info.id);
    const completedOutput =
      type === "message.updated" && info?.role === "assistant" &&
        info.time.completed !== undefined
        ? this.buffers.outputEnd(info.id)
        : undefined;
    if (
      type === "message.updated" && info?.role === "assistant" &&
      info.time.completed !== undefined
    ) {
      this.buffers.complete(info.id, (id, op) => {
        sink.content(id, op);
      });
    }
    if (type === "message.updated" && info?.time.completed !== undefined) {
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
      info.time.completed
    ) {
      const current = this.#index.getMetadata(sessionID);
      if (current) {
        current.timeUpdated = Math.max(
          current.timeUpdated,
          info.time.completed,
        );
        sink.indexUpsert(current);
      }
    }
    if (type === "message.removed") {
      this.#clocks.release(sessionID, String(p.messageID));
      this.#selectionIntents.release(ids.decode(sessionID));
      this.#recovery.message(String(p.messageID), sessionID);
      this.buffers.removeMessage(String(p.messageID));
    }
    if (type === "message.part.removed") {
      this.#clocks.release(sessionID, String(p.messageID));
      this.#recovery.part(String(p.messageID), String(p.partID), sessionID);
      this.buffers.forgetPart(String(p.messageID), String(p.partID));
    }
    if (type === "message.part.updated" && raw && raw.tool !== "task") {
      this.#tasks.remove(sessionID, raw.messageID, raw.id);
    }
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
          const message = mapMessage(
              info!,
              [],
              completedOutput ?? this.buffers.outputTime(info!.id),
            ),
            colors = this.#colors.peek(this.#directory(sessionID), sessionID);
          if (!this.#current(controller)) return;
          if (message.agent !== undefined) {
            message.agentColor = colors?.get(message.agent);
          }
          content({ op: "message.upsert", message });
          if (
            message.role === "assistant" &&
            message.time.completed !== undefined &&
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
        const part = finishedPart ||
          this.buffers.snapshot(raw.id, sessionID, raw.messageID)?.part ||
          mapPart(raw);
        const intent = this.#selectionIntents.part(raw);
        if (part.kind === "tool" && intent) part.call.selectionIntent = intent;
        if (part.kind === "tool" && raw.tool === "task") {
          part.call = this.#tasks.shape(raw);
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
        if (p.field !== "text") break;
        const id = String(p.partID);
        if (
          !this.buffers.append(
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
