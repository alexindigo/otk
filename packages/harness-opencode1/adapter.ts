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
import { agentColors, agents } from "./agents.ts";
import { resources } from "./resources.ts";
import { commands } from "./commands.ts";
import { type Launch, shell } from "./shell.ts";
import { permissions } from "./permissions.ts";
import { revert } from "./revert.ts";
import { sessionDirectory } from "./directory.ts";
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
  #entries = new Map<string, IndexEntry>();
  #permissions = new Map<
    string,
    { sessionID: string; callID?: string; time: number }
  >();
  #questions = new Map<string, string>();
  #stopped = true;
  #commands = new Map<
    AbortController,
    { sessionID: string; task: Promise<void> }
  >();
  #errors = new SessionErrors((id, state) => this.#publishErrors(id, state));
  #controller?: AbortController;
  #run?: Promise<void>;
  #wake?: () => void;
  #db: BootstrapDb;
  #history: History;
  #tasks: TaskProgress;
  #reverts = new Map<string, string>();
  constructor(
    readonly cfg: Opencode1Config,
    readonly buffers: StreamBuffers = new StreamBuffers(),
    fetcher = fetch,
  ) {
    this.client = new Client(cfg.harness, fetcher);
    this.#db = new BootstrapDb(harnessDb(cfg));
    this.#history = new History(harnessDb(cfg));
    this.#tasks = new TaskProgress(
      async (id, message) => {
        const options = { query: { directory: this.#directory(id) } };
        if (message) {
          return [
            await this.client.json<{ info: Info; parts: RawPart[] }>(
              `/session/${encodeURIComponent(id)}/message/${
                encodeURIComponent(message)
              }`,
              options,
            ),
          ];
        }
        return this.client.json<{ info: Info; parts: RawPart[] }[]>(
          `/session/${encodeURIComponent(id)}/message`,
          options,
        );
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
      (id) => this.core.getSession(id),
    );
    const version = () => this.version;
    this.core = sessions(
      this.client,
      directory,
      this.buffers,
      this.#tasks,
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
    registry.register("resources", resources(this.client, directory));
    registry.register(
      "permissions",
      permissions(
        this.client,
        directory,
        (id) => this.#entries.get(id),
        (id) => this.#permissions.get(id)?.time,
      ),
    );
    registry.register(
      "questions",
      questions(
        this.client,
        directory,
        (id) => this.#entries.get(id),
        this.#questions,
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
    this.#sink = sink;
    this.#stopped = false;
    sink.connection("connecting");
    this.#run = this.#loop();
    return Promise.resolve();
  }
  async #stop(): Promise<void> {
    this.#stopped = true;
    this.#controller?.abort();
    this.#abortCommands();
    this.#errors.reset();
    this.#wake?.();
    this.buffers.stop();
    this.#tasks.release();
    await this.#run;
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
  }
  #directory(id: string): string | undefined {
    return this.#entries.get(id)?.directory;
  }
  async #revertInfo(session: Session): Promise<RevertInfo | undefined> {
    if (!session.revert) {
      this.#reverts.delete(session.id);
      return;
    }
    if (this.buffers.subscribed(session.id)) {
      this.#reverts.set(session.id, session.revert.messageID);
    }
    const messages = await this.client.json<{ info: Info }[]>(
      `/session/${encodeURIComponent(session.id)}/message`,
      { query: { directory: session.directory } },
    );
    const files = session.revert.diff
      ? parseDiff(session.revert.diff)
      : mapDiffs(session.summary?.diffs || []);
    return {
      messageID: session.revert.messageID,
      messageCount: messages.filter((message) =>
        message.info.role === "user" &&
        message.info.id >= session.revert!.messageID
      ).length,
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
    const entry = this.#entries.get(sessionID);
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
  async #loop(): Promise<void> {
    const backoff = new Backoff(this.cfg.harness.reconnectmax);
    while (!this.#stopped) {
      const controller = this.#controller = new AbortController();
      const watchdog = new Watchdog(
        this.cfg.harness.heartbeattimeout * 1000,
        () => controller.abort(),
      );
      let chain = Promise.resolve(), ready = false;
      const buffered: Envelope[] = [];
      try {
        const health = await this.client.json<{ version: string }>(
          "/global/health",
        );
        this.version = health.version;
        watchdog.touch();
        const response = await this.client.request("/global/event", {
          signal: controller.signal,
          stream: true,
        });
        await consumeEvents(response, () => watchdog.touch(), (event) => {
          if (event.payload.type === "server.connected") {
            backoff.connected();
            chain = this.#bootstrap().then(async () => {
              ready = true;
              this.#sink.connection("connected");
              this.#sink.resync("all");
              for (const pending of buffered.splice(0)) {
                await this.#event(pending);
              }
            }).catch((error) => {
              console.warn("bootstrap:", error);
              controller.abort();
            });
          } else if (event.payload.type !== "server.heartbeat") {
            if (!ready) buffered.push(event);
            else {
              chain = chain.then(() => this.#event(event)).catch(
                (error) => {
                  console.warn("event:", error);
                  controller.abort();
                },
              );
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
        if (!this.#stopped) {
          console.warn(`harness stream: ${(error as Error).message}`);
        }
      } finally {
        watchdog.stop();
        controller.abort();
        await chain;
      }
      if (this.#stopped) break;
      this.buffers.reset();
      this.#sink.connection("reconnecting");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoff.next());
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = undefined;
    }
  }
  async #bootstrap(): Promise<void> {
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
      });
      for (const session of await response.json() as Session[]) {
        this.#errors.register(session.id);
        const entry = mapIndex(session);
        this.#errorEntry(entry);
        entries.set(session.id, entry);
      }
      const next = response.headers.get("x-next-cursor") ?? undefined;
      if (next && next === cursor) {
        throw new Error("Harness session pagination did not advance");
      }
      cursor = next;
    } while (cursor);
    this.#entries = entries;
    const previousPermissions = new Map(this.#permissions);
    this.#permissions.clear();
    this.#questions.clear();
    for (const directory of this.#db.possiblyRunningDirectories(since)) {
      const [statuses, permissions, questions] = await Promise.all([
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
        >("/session/status", { query: { directory } }),
        this.client.json<RawPermission[]>("/permission", {
          query: { directory },
        }),
        this.client.json<{ id: string; sessionID: string }[]>("/question", {
          query: { directory },
        }),
      ]);
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
        this.#permissions.set(request.id, {
          sessionID: request.sessionID,
          callID: request.tool?.callID,
          time: previousPermissions.get(request.id)?.time ?? Date.now(),
        });
      }
      for (const request of questions) {
        this.#questions.set(request.id, request.sessionID);
      }
    }
    this.#attention(false);
    this.#sink.indexReset([...entries.values()]);
  }
  #attention(emit = true): void {
    const before = new Map(
      [...this.#entries].map((
        [id, entry],
      ) => [id, JSON.stringify(entry.attention)]),
    );
    for (const entry of this.#entries.values()) {
      entry.attention.permissions =
        entry.attention.questions =
        entry.attention.childPermissions =
        entry.attention.childQuestions =
          0;
    }
    const add = (sessionID: string, kind: "permissions" | "questions") => {
      const entry = this.#entries.get(sessionID);
      if (!entry) return;
      entry.attention[kind]++;
      const seen = new Set([sessionID]);
      let parent = entry.parentID;
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const ancestor = this.#entries.get(parent);
        if (!ancestor) break;
        ancestor.attention[
          kind === "permissions" ? "childPermissions" : "childQuestions"
        ]++;
        parent = ancestor.parentID;
      }
    };
    for (const request of this.#permissions.values()) {
      add(request.sessionID, "permissions");
    }
    for (const sessionID of this.#questions.values()) {
      add(sessionID, "questions");
    }
    if (emit) {
      for (const [id, entry] of this.#entries) {
        if (before.get(id) !== JSON.stringify(entry.attention)) {
          this.#sink.indexUpsert(entry);
        }
      }
    }
  }
  async #event(event: Envelope): Promise<void> {
    if (this.#stopped) return;
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
      await this.#bootstrap();
      this.#sink.resync("all");
      return;
    }
    const info = p.info as Info | undefined;
    const raw = p.part as RawPart | undefined;
    const sessionID = String(
      p.sessionID ?? info?.sessionID ?? raw?.sessionID ?? "",
    );
    const entry = this.#entries.get(sessionID);
    if (type === "session.created" || type === "session.updated") {
      const session = p.info as Session,
        old = this.#entries.get(session.id),
        mapped = mapIndex(session);
      this.#errors.register(session.id);
      if (old) {
        mapped.status = old.status;
        mapped.retry = old.retry;
        mapped.attention = old.attention;
      }
      this.#errorEntry(mapped);
      this.#entries.set(mapped.id, mapped);
      this.#sink.indexUpsert(mapped);
      this.#attention();
      if (
        this.buffers.subscribed(session.id) &&
        (session.revert || this.#reverts.has(session.id))
      ) {
        const revert = await this.#revertInfo(session);
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
      this.#abortCommands(id);
      this.#errors.remove(id);
      this.#entries.delete(id);
      this.#sink.indexRemove(id);
      this.#attention();
      this.buffers.removeSession(id);
      return;
    }
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
      if (status.type === "busy") this.#errors.clear(sessionID);
      else if (entry) this.#sink.indexUpsert(entry);
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
      this.#permissions.set(request.id, {
        sessionID,
        callID: request.tool?.callID,
        time: this.#permissions.get(request.id)?.time ?? Date.now(),
      });
      this.#attention();
      this.#sink.content(sessionID, {
        op: "permission.upsert",
        request: mapPermission(
          request,
          this.#permissions.get(request.id)!.time,
        ),
      });
      return;
    }
    if (type === "permission.replied") {
      this.#permissions.delete(String(p.requestID));
      this.#attention();
      this.#sink.content(sessionID, {
        op: "permission.remove",
        requestID: String(p.requestID),
        sessionID,
      });
      return;
    }
    if (type === "question.asked") {
      this.#questions.set(String(p.id), sessionID);
      this.#attention();
      this.#sink.content(sessionID, {
        op: "question.upsert",
        request: mapQuestion(p as unknown as RawQuestion),
      });
      return;
    }
    if (type === "question.replied" || type === "question.rejected") {
      this.#questions.delete(String(p.requestID));
      this.#attention();
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
    ) this.buffers.complete(info.id, (id, op) => this.#sink.content(id, op));
    if (
      type === "message.updated" && info?.role === "assistant" &&
      info.time.completed !== undefined && completedOutput === undefined &&
      this.buffers.subscribed(sessionID)
    ) {
      const finished = await this.client.json<{ info: Info; parts: RawPart[] }>(
        `/session/${encodeURIComponent(sessionID)}/message/${
          encodeURIComponent(info.id)
        }`,
        { query: { directory: this.#directory(sessionID) } },
      );
      const message = mapMessage(info, finished.parts);
      if (message.role === "assistant") {
        completedOutput = message.time.lastOutput;
      }
      if (this.#stopped) return;
    }
    if (
      type === "message.updated" && info?.role === "assistant" &&
      info.time.completed
    ) {
      if (entry) {
        entry.timeUpdated = Math.max(entry.timeUpdated, info.time.completed);
        this.#sink.indexUpsert(entry);
      }
    }
    if (type === "message.removed") {
      this.buffers.removeMessage(String(p.messageID));
    }
    if (type === "message.part.removed") {
      this.buffers.forgetPart(String(p.messageID), String(p.partID));
    }
    if (type === "message.part.updated" && raw) {
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
        (id, op) => this.#sink.content(id, op),
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
      if (!this.#stopped && this.buffers.subscribed(sessionID)) {
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
            colors = await agentColors(this.client, this.#directory(sessionID));
          message.agentColor = colors.get(info!.agent);
          content({ op: "message.upsert", message });
        }
        break;
      case "message.removed":
        content({ op: "message.remove", messageID: String(p.messageID) });
        break;
      case "message.part.updated": {
        if (!raw) break;
        const waiting = [...this.#permissions.values()].some((request) =>
          request.callID === raw.callID && request.sessionID === sessionID
        );
        const part = this.buffers.snapshot(raw.id)?.part ||
          mapPart(raw, waiting);
        if (part.kind === "tool" && raw.tool === "task") {
          part.call = await this.#tasks.shape(raw);
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
            (id, op) => this.#sink.content(id, op),
          )
        ) {
          // Mid-stream subscriber: no event-consistent seed exists. Fetch current
          // content per request instead of guessing which deltas the snapshot includes.
          const message = await this.client.json<
            { info: Info; parts: RawPart[] }
          >(
            `/session/${encodeURIComponent(sessionID)}/message/${
              encodeURIComponent(String(p.messageID))
            }`,
            { query: { directory: this.#directory(sessionID) } },
          );
          const current = message.parts.find((item) => item.id === id);
          if (current && this.buffers.subscribed(sessionID)) {
            if (
              message.info.role === "assistant" &&
              message.info.time.completed === undefined
            ) this.buffers.beginReply(sessionID, message.info.id);
            const lastOutput = this.buffers.observeOutput(
              sessionID,
              String(p.messageID),
              Date.now(),
              current.time?.end,
              current.id,
            );
            content({
              op: "part.upsert",
              messageID: String(p.messageID),
              part: mapPart(current),
              ...(lastOutput === undefined ? {} : { lastOutput }),
            });
          }
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
