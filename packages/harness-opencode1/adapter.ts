// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentOp, RevertInfo, Todo } from "@otk/protocol";
import type { IndexEntry } from "@otk/protocol";
import { harnessDb, type Opencode1Config } from "./config.ts";
import { parseDiff, StreamBuffers } from "@otk/content";
import {
  type Capabilities,
  CapabilityRegistry,
  type Harness,
  type HarnessCore,
  HarnessError,
  type HarnessSink,
  SessionIndex,
} from "@otk/harness";
import { Client, HttpFailure } from "./client.ts";
import { SessionErrors } from "./errors.ts";
import { sessionErrorMessage, type SessionErrorState } from "@otk/protocol";
import { BootstrapDb } from "./db.ts";
import { History } from "./history.ts";
import { consumeEvents } from "./events.ts";
import { mapDiffs, mapIndex, mapMessage, mapPart } from "./map.ts";
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
import { revert } from "./revert.ts";
import { sessionDirectory } from "./directory.ts";
import { Messages } from "./messages.ts";
import { Attention } from "./attention.ts";
import { MessageRecovery } from "./recovery.ts";
const contentEvents = new Set([
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
export class Opencode1Adapter implements Harness {
  readonly core: HarnessCore;
  readonly capabilities: Readonly<Required<Capabilities>>;
  readonly kind = "opencode1";
  version = "unknown";
  readonly client: Client;
  #sink!: HarnessSink;
  #index = new SessionIndex();
  #attention = new Attention(
    (id) => this.#index.get(id),
    (entry) => this.#sink.indexUpsert(entry),
    (id) => this.#sink.indexRemove(id),
    (id) => this.#index.descendants(id),
  );
  #permissions = new Map<string, PendingPermission>();
  #questions = new Map<string, string>();
  get #stopped(): boolean {
    return !this.#run || this.#run.controller.signal.aborted;
  }
  #commands = new Map<
    AbortController,
    { sessionID: string; task: Promise<void> }
  >();
  #errors = new SessionErrors((id, state) => this.#publishErrors(id, state));
  #controller?: AbortController;
  #run?: { controller: AbortController; task: Promise<void> };
  #stopping?: Promise<void>;
  #db: BootstrapDb;
  #history: History;
  #tasks: TaskProgress;
  #messages: Messages;
  #colors: AgentColors;
  #recovery: MessageRecovery;
  #reverts = new Map<string, string>();
  constructor(
    readonly cfg: Opencode1Config,
    readonly buffers: StreamBuffers = new StreamBuffers(),
    fetcher = fetch,
  ) {
    this.client = new Client(cfg.harness, fetcher);
    this.#db = new BootstrapDb(harnessDb(cfg));
    this.#history = new History(harnessDb(cfg));
    this.#messages = new Messages(this.client, (id) => this.#directory(id));
    this.#colors = new AgentColors(this.client);
    this.#recovery = new MessageRecovery(
      (session, message, signal) =>
        this.#messages.get(session, message, signal),
      (session, snapshot, parts) => {
        if (this.#stopped || !this.buffers.subscribed(session)) return;
        const cutoff = this.#reverts.get(session);
        if (cutoff && snapshot.info.id >= cutoff) return;
        for (const raw of snapshot.parts) {
          if (!parts.has(raw.id)) continue;
          if (
            snapshot.info.role === "assistant" &&
            snapshot.info.time.completed === undefined
          ) {
            this.buffers.beginReply(session, snapshot.info.id);
          }
          const lastOutput = this.buffers.observeOutput(
            session,
            snapshot.info.id,
            Date.now(),
            raw.time?.end,
            raw.id,
          );
          this.#sink.content(session, {
            op: "part.upsert",
            messageID: snapshot.info.id,
            part: mapPart(raw),
            ...(lastOutput === undefined ? {} : { lastOutput }),
          });
        }
      },
      (error) => console.warn("message recovery:", error),
    );
    this.#tasks = new TaskProgress(
      async (id, message) => {
        if (message) {
          return [await this.#messages.get(id, message)];
        }
        return this.#db.taskMessages(id) ?? this.#messages.scan(id);
      },
      (id) => this.buffers.subscribed(id),
      (parent, messageID, part) => {
        const cutoff = this.#reverts.get(parent);
        if (!this.#stopped && (!cutoff || messageID < cutoff)) {
          const lastOutput = this.buffers.observeOutput(
            parent,
            messageID,
            Date.now(),
            part.kind === "tool" ? part.call.time.end : undefined,
            part.id,
          );
          this.#sink.content(parent, {
            op: "part.upsert",
            messageID,
            part,
            ...(lastOutput === undefined ? {} : { lastOutput }),
          });
        }
      },
      () => this.#sink.resync("all"),
    );
    const directory = sessionDirectory(
      (id) => this.#directory(id),
      (id) => this.client.json<Session>(`/session/${encodeURIComponent(id)}`),
    );
    const version = () => this.version;
    this.core = sessions(
      this.client,
      directory,
      this.buffers,
      this.#tasks,
      this.#messages,
      {
        kind: this.kind,
        get version() {
          return version();
        },
        start: (sink) => this.#start(sink),
        stop: () => this.#stop(),
        subscriptions: (id, count) => this.#subscriptions(id, count),
      },
      (raw) => this.#revertInfo(raw),
      (id) => this.#errors.snapshot(id),
      this.#colors,
    );
    const registry = new CapabilityRegistry();
    const launch: Launch = (...args) => this.#launch(...args);
    registry.register(
      "prompt",
      prompt(this.client, directory, (id) => {
        this.#abortCommands(id);
        this.#errors.cancel(id);
      }),
    );
    registry.register("shell", shell(this.client, directory, launch));
    registry.register("commands", commands(this.client, directory, launch));
    registry.register("history", this.#history);
    registry.register("files", files(this.client, directory));
    registry.register("agents", agents(this.client, directory));
    registry.register("models", models(this.client, directory));
    registry.register("usage", usage(this.#db, this.#messages, directory));
    registry.register("resources", resources(this.client, directory));
    registry.register(
      "permissions",
      permissions(
        this.client,
        directory,
        (id) => this.#index.get(id),
        () => this.#permissions.values(),
      ),
    );
    registry.register(
      "questions",
      questions(
        this.client,
        directory,
        (id) => this.#index.get(id),
        this.#questions,
        (id, session) => this.#question(id, session),
      ),
    );
    registry.register(
      "revert",
      revert(this.client, directory, (id) => this.core.getSession(id)),
    );
    this.capabilities = registry.capabilities as Readonly<
      Required<Capabilities>
    >;
  }
  #start(sink: HarnessSink): Promise<void> {
    if (this.#run || this.#stopping) {
      return Promise.reject(
        new HarnessError("started", "Harness is already started"),
      );
    }
    this.#index = sink.index ?? new SessionIndex();
    // Standalone consumers need no index implementation. In core, callbacks
    // already mutate the injected owner; never maintain a mirrored map.
    this.#sink = sink.index ? sink : {
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
    run.task = Promise.resolve().then(() => this.#loop(run.controller.signal));
    sink.connection("connecting");
    return Promise.resolve();
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
  async #shutdown(): Promise<void> {
    this.#abortCommands();
    this.#errors.reset();
    this.buffers.stop();
    this.#tasks.release();
    await this.#recovery.stop();
    this.#colors.clear();
    await this.#run?.task;
    await Promise.all(
      [...this.#commands.values()].map((request) => request.task),
    );
    this.#db.close();
    this.#history.close();
  }
  #subscriptions(id: string, count: number): void {
    this.buffers.subscriptions(id, count);
    if (count && !this.#stopped) {
      this.buffers.replay(
        id,
        (sessionID, op) => this.#sink.content(sessionID, op),
      );
    }
    if (!count) this.#tasks.release(id);
    if (!count) this.#reverts.delete(id);
    if (!count) this.#recovery.release(id);
  }
  #directory(id: string): string | undefined {
    return this.#index.get(id)?.directory;
  }
  async #revertInfo(session: Session): Promise<RevertInfo | undefined> {
    if (!session.revert) {
      this.#reverts.delete(session.id);
      return;
    }
    if (this.buffers.subscribed(session.id)) {
      this.#reverts.set(session.id, session.revert.messageID);
    }
    let messageCount = this.#db.revertedUserCount(
      session.id,
      session.revert.messageID,
    );
    if (messageCount === undefined) {
      messageCount = 0;
      for await (
        const message of this.#messages.scan(session.id, session.directory)
      ) {
        if (
          message.info.role === "user" &&
          message.info.id >= session.revert.messageID
        ) messageCount++;
      }
    }
    const files = session.revert.diff
      ? parseDiff(session.revert.diff)
      : mapDiffs(session.summary?.diffs || []);
    return {
      messageID: session.revert.messageID,
      messageCount,
      files: files.map(({ path, additions, deletions }) => ({
        path,
        additions,
        deletions,
      })),
    };
  }
  #launch(
    sessionID: string,
    operation: "shell" | "command",
    path: string,
    options: Parameters<Client["request"]>[1],
  ): void {
    if (this.#stopped) throw new HarnessError("stopped", "Harness is stopped");
    const controller = new AbortController();
    const token = this.#errors.begin(sessionID, operation);
    const request = this.client.json(path, {
      ...options,
      signal: controller.signal,
      timeout: null,
    }).then(() => this.#errors.settled(token)).catch((error) => {
      if (!this.#stopped && !controller.signal.aborted) {
        this.#errors.http(
          token,
          error instanceof HttpFailure
            ? { ...error.detail, status: error.status }
            : {
              message: (error as Error).message || "Harness error",
              kind: (error as Error).name,
            },
        );
      }
    }).finally(() => {
      this.#errors.settled(token);
      this.#commands.delete(controller);
    });
    this.#commands.set(controller, { sessionID, task: request });
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
    const entry = this.#index.get(sessionID);
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
      controller.signal.addEventListener("abort", () => {
        this.#recovery.release();
        this.#tasks.release();
        this.buffers.reset();
      }, { once: true });
      const watchdog = new Watchdog(
        this.cfg.harness.heartbeattimeout * 1000,
        () => controller.abort(),
      );
      let chain = Promise.resolve(), ready = false, bootstrapping = false;
      const buffered: Envelope[] = [];
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
          stream: true,
        });
        if (!this.#current(controller)) {
          await response.body?.cancel();
          controller.signal.throwIfAborted();
        }
        await consumeEvents(response, () => watchdog.touch(), (event) => {
          if (!this.#current(controller)) return;
          if (event.payload.type === "server.connected") {
            if (bootstrapping) return;
            bootstrapping = true;
            backoff.connected();
            chain = this.#bootstrap(controller).then(async () => {
              if (!this.#current(controller)) return;
              ready = true;
              this.#sink.connection("connected");
              if (!this.#current(controller)) return;
              this.#sink.resync("all");
              for (const pending of buffered.splice(0)) {
                if (!this.#current(controller)) break;
                await this.#handle(pending, controller);
              }
            }).catch((error) => {
              if (this.#current(controller)) console.warn("bootstrap:", error);
              controller.abort();
            });
          } else if (event.payload.type !== "server.heartbeat") {
            if (!ready) buffered.push(event);
            else {
              chain = chain.then(() => this.#handle(event, controller));
              // Once bootstrap is ready, the parser owns at most the event being
              // forwarded, rather than accumulating content in a promise queue.
              return chain;
            }
          }
        }, (type) => {
          if (
            contentEvents.has(type) || type === "server.connected" ||
            type === "server.heartbeat"
          ) return true;
          console.debug(`harness event ignored: ${type}`);
          return false;
        });
      } catch (error) {
        if (this.#current(controller)) {
          console.warn(`harness stream: ${(error as Error).message}`);
        }
      } finally {
        watchdog.stop();
        controller.abort();
        await chain;
        buffered.length = 0;
        this.#recovery.release();
        this.#controller = undefined;
      }
      if (signal.aborted) break;
      this.buffers.reset();
      this.#sink.connection("reconnecting");
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
    this.#recovery.release();
    this.#reverts.clear();
    this.#tasks.release();
    // Every authoritative resync starts a new content generation. Keep viewers,
    // but never carry raw streaming seeds or timers across a disposed instance.
    this.buffers.reset();
    const since = Date.now() - this.cfg.index.days * 86_400_000;
    const entries = new Map<string, IndexEntry>();
    let cursor: string | undefined;
    do {
      const response = await this.client.request("/experimental/session", {
        query: { start: since, limit: 200, cursor },
        signal: controller.signal,
      });
      if (!this.#current(controller)) {
        await response.body?.cancel();
        return;
      }
      const sessions = await response.json() as Session[];
      if (!this.#current(controller)) return;
      for (const session of sessions) {
        const entry = mapIndex(session);
        entries.set(session.id, entry);
      }
      const next = response.headers.get("x-next-cursor") ?? undefined;
      if (next && next === cursor) {
        throw new Error("Harness session pagination did not advance");
      }
      cursor = next;
    } while (cursor);
    const previousPermissions = new Map(this.#permissions);
    const nextPermissions = new Map<string, PendingPermission>();
    const nextQuestions = new Map<string, string>();
    // Native directory reads create retained instances and touch project clocks.
    // Only unavailable hints require the bounded session-window API fallback.
    const hints = this.#db.possiblyRunningDirectories(since);
    const directories = new Set(
      hints ?? [...entries.values()].map((entry) => entry.directory),
    );
    const inventory = async (directory: string) => {
      const local = new AbortController();
      const signal = AbortSignal.any([controller.signal, local.signal]);
      const reads = [
        this.client.json<
          Record<
            string,
            {
              type: IndexEntry["status"];
              attempt?: number;
              message?: string;
              next?: number;
            }
          >
        >("/session/status", {
          query: { directory },
          signal,
        }),
        this.client.json<RawPermission[]>("/permission", {
          query: { directory },
          signal,
        }),
        this.client.json<{ id: string; sessionID: string }[]>("/question", {
          query: { directory },
          signal,
        }),
      ] as const;
      try {
        const [statuses, permissions, questions] = await Promise.all(reads)
          .catch(async (error) => {
            local.abort();
            await Promise.allSettled(reads);
            throw error;
          });
        if (!this.#current(controller)) return;
        for (const [id, status] of Object.entries(statuses)) {
          const entry = entries.get(id);
          if (!entry) continue;
          entry.status = status.type;
          if (status.type === "retry") {
            entry.retry = {
              attempt: status.attempt!,
              message: status.message!,
              next: status.next!,
            };
          }
        }
        for (const request of permissions) {
          nextPermissions.set(
            request.id,
            {
              directory,
              request: mapPermission(
                request,
                previousPermissions.get(request.id)?.request.time ?? Date.now(),
              ),
            },
          );
        }
        for (const request of questions) {
          nextQuestions.set(request.id, request.sessionID);
        }
      } catch (error) {
        if (!this.#current(controller)) return;
        console.warn(
          `bootstrap directory ${JSON.stringify(directory)}:`,
          error,
        );
        // A failed inventory is not evidence that previous work/input ended.
        for (const entry of entries.values()) {
          if (entry.directory !== directory) continue;
          const previous = this.#index.get(entry.id);
          if (previous) {
            entry.status = previous.status;
            entry.retry = previous.retry;
          }
        }
        for (const [id, pending] of previousPermissions) {
          if (pending.directory === directory) nextPermissions.set(id, pending);
        }
        for (const [id, sessionID] of this.#questions) {
          if (
            (entries.get(sessionID) ?? this.#index.get(sessionID))
              ?.directory === directory
          ) {
            nextQuestions.set(id, sessionID);
          }
        }
      }
    };
    const remaining = directories.values();
    await Promise.all(
      Array.from({ length: Math.min(4, directories.size) }, async () => {
        for (const directory of remaining) {
          if (!this.#current(controller)) return;
          await inventory(directory);
        }
      }),
    );
    if (!this.#current(controller)) return;
    for (const entry of entries.values()) {
      this.#errors.register(entry.id);
      this.#errorEntry(entry);
    }
    this.#permissions = nextPermissions;
    this.#questions.clear();
    for (const [id, sessionID] of nextQuestions) {
      this.#questions.set(id, sessionID);
    }
    this.#attention.reset(
      [...entries.values()],
      [...this.#permissions.values()].map(({ request }) => request.sessionID),
      this.#questions.values(),
    );
    this.#sink.indexReset([...entries.values()]);
  }
  #question(id: string, session?: string): void {
    const previous = this.#questions.get(id);
    if (previous === session) return;
    if (previous) this.#attention.change(previous, "questions", -1);
    if (session) {
      this.#questions.set(id, session);
      this.#attention.change(session, "questions", 1);
    } else this.#questions.delete(id);
  }
  async #handle(event: Envelope, controller: AbortController): Promise<void> {
    try {
      await this.#event(event, controller);
    } catch (error) {
      if (this.#current(controller)) {
        console.warn("harness event:", event.payload?.type, error);
      }
    }
  }
  async #event(event: Envelope, controller: AbortController): Promise<void> {
    if (!this.#current(controller)) return;
    const { type, properties: p } = event.payload;
    // The 1.x bridge emits both the legacy event and its durable "sync"
    // companion. The latter has syncEvent, not properties; do not apply twice.
    if (!contentEvents.has(type)) {
      console.debug(`harness event ignored: ${type}`);
      return;
    }
    if (!p) throw new Error(`Malformed ${type} event: properties missing`);
    if (type === "server.instance.disposed") {
      this.#abortCommands();
      this.#errors.reset();
      this.#colors.clear();
      try {
        await this.#bootstrap(controller);
      } catch (error) {
        // A failed authoritative bootstrap remains a connection-level failure.
        controller.abort();
        throw error;
      }
      if (this.#current(controller)) this.#sink.resync("all");
      return;
    }
    const info = p.info as Info | undefined;
    const raw = p.part as RawPart | undefined;
    const identity = p.sessionID ?? info?.sessionID ?? raw?.sessionID;
    const sessionID = typeof identity === "string" ? identity : "";
    const entry = this.#index.get(sessionID);
    if (type === "session.created" || type === "session.updated") {
      if (typeof info?.id !== "string" || !info.id) {
        throw new Error(`Malformed ${type}: session id missing`);
      }
      const session = p.info as Session,
        old = this.#index.get(session.id),
        mapped = mapIndex(session);
      this.#errors.register(session.id);
      if (old) {
        mapped.status = old.status;
        mapped.retry = old.retry;
        mapped.attention = old.attention;
      }
      this.#errorEntry(mapped);
      this.#attention.upsert(mapped);
      if (
        this.buffers.subscribed(session.id) &&
        (session.revert || this.#reverts.has(session.id))
      ) {
        const revert = await this.#revertInfo(session);
        if (!this.#current(controller)) return;
        this.#sink.content(session.id, {
          op: "session.revert",
          messageID: revert?.messageID,
          messageCount: revert?.messageCount || 0,
          files: revert?.files || [],
        });
        this.#sink.resync("all");
      }
      return;
    }
    if (type === "session.deleted") {
      const id = (p.info as Session).id;
      if (typeof id !== "string" || !id) {
        throw new Error("Malformed session.deleted: session id missing");
      }
      this.#abortCommands(id);
      this.#errors.remove(id);
      this.#attention.remove(id);
      this.#recovery.release(id);
      this.buffers.removeSession(id);
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
      if (entry) this.#sink.indexUpsert(entry);
      if (status.type === "busy") this.#errors.clear(sessionID);
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
        this.#sink.indexUpsert(entry);
      }
      this.#sink.content(sessionID, {
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
      this.#sink.content(sessionID, {
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
      this.#question(String(p.id), sessionID);
      this.#sink.content(sessionID, {
        op: "question.upsert",
        request,
      });
      return;
    }
    if (type === "question.replied" || type === "question.rejected") {
      this.#question(String(p.requestID));
      this.#sink.content(sessionID, {
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
    let completedOutput =
      type === "message.updated" && info?.role === "assistant" &&
        info.time.completed !== undefined
        ? this.buffers.outputEnd(info.id)
        : undefined;
    if (
      type === "message.updated" && info?.role === "assistant" &&
      info.time.completed !== undefined
    ) {
      this.buffers.complete(info.id, (id, op) => {
        if (this.#current(controller)) this.#sink.content(id, op);
      });
    }
    if (type === "message.updated" && info?.time.completed !== undefined) {
      this.#recovery.message(info.id);
    }
    if (
      type === "message.updated" && info?.role === "assistant" &&
      info.time.completed !== undefined && completedOutput === undefined &&
      this.buffers.subscribed(sessionID)
    ) {
      const finished = await this.client.json<{ info: Info; parts: RawPart[] }>(
        `/session/${encodeURIComponent(sessionID)}/message/${
          encodeURIComponent(info.id)
        }`,
        {
          query: { directory: this.#directory(sessionID) },
          signal: controller.signal,
        },
      );
      const message = mapMessage(info, finished.parts);
      if (message.role === "assistant") {
        completedOutput = message.time.lastOutput;
      }
      if (!this.#current(controller)) return;
    }
    if (
      type === "message.updated" && info?.role === "assistant" &&
      info.time.completed
    ) {
      const current = this.#index.get(sessionID);
      if (current) {
        current.timeUpdated = Math.max(
          current.timeUpdated,
          info.time.completed,
        );
        this.#sink.indexUpsert(current);
      }
    }
    if (type === "message.removed") {
      this.#recovery.message(String(p.messageID));
      this.buffers.removeMessage(String(p.messageID));
    }
    if (type === "message.part.removed") {
      this.#recovery.part(String(p.messageID), String(p.partID));
      this.buffers.forgetPart(String(p.messageID), String(p.partID));
    }
    if (type === "message.part.updated" && raw) {
      this.#recovery.part(raw.messageID, raw.id);
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
        const part = mapPart(raw);
        if (part.kind === "text" || part.kind === "reasoning") {
          this.buffers.upsert(sessionID, raw.messageID, part, raw.text || "");
        }
      } else this.buffers.remove(raw.id);
    }
    if (
      type === "message.part.delta" && p.field === "text" &&
      this.buffers.append(
        String(p.partID),
        String(p.delta),
        (id, op) => {
          if (this.#current(controller)) this.#sink.content(id, op);
        },
      )
    ) return;
    if (type === "message.updated" || type === "message.part.updated") {
      this.#tasks.observe(sessionID, info, raw);
    }
    if (!this.buffers.subscribed(sessionID)) return;
    const cutoff = this.#reverts.get(sessionID),
      messageID = info?.id || raw?.messageID || String(p.messageID || "");
    if (cutoff && messageID && messageID >= cutoff) return;
    const content = (op: ContentOp) => {
      if (this.#current(controller) && this.buffers.subscribed(sessionID)) {
        this.#sink.content(sessionID, op);
      }
    };
    switch (type) {
      case "message.updated":
        {
          const message = mapMessage(
              info!,
              [],
              completedOutput ?? this.buffers.outputTime(info!.id),
            ),
            colors = await this.#colors.get(this.#directory(sessionID));
          if (!this.#current(controller)) return;
          if (message.agent !== undefined) {
            message.agentColor = colors.get(message.agent);
          }
          content({ op: "message.upsert", message });
        }
        break;
      case "message.removed":
        content({ op: "message.remove", messageID: String(p.messageID) });
        break;
      case "message.part.updated": {
        if (!raw) break;
        const waiting = [...this.#permissions.values()].some(({ request }) =>
          request.toolCall === raw.callID && request.sessionID === sessionID
        );
        const part = this.buffers.snapshot(raw.id)?.part ||
          mapPart(raw, waiting);
        if (part.kind === "tool" && raw.tool === "task") {
          part.call = await this.#tasks.shape(raw);
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
              if (this.#current(controller)) this.#sink.content(id, op);
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
        console.debug(`harness event ignored: ${type}`);
    }
  }
}
