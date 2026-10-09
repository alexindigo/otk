// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentOp,
  ContentSession,
  Message,
  PermissionRequest,
  RevertInfo,
  Todo,
} from "../../../protocol/content.ts";
import type { IndexEntry } from "../../../protocol/index.ts";
import { belongsToSession } from "../../../protocol/session-tree.ts";
import type { PermissionReply, PromptInput } from "../../../protocol/rpc.ts";
import type { ServiceConfig } from "../../config/schema.ts";
import { harnessDb } from "../../config/loader.ts";
import { StreamBuffers } from "../../content/buffers.ts";
import type { HarnessAdapter, HarnessSink } from "../types.ts";
import { Client } from "./client.ts";
import { BootstrapDb } from "./db.ts";
import { consumeEvents } from "./events.ts";
import { mapDiffs, mapIndex, mapMessage, mapPart, mapSession } from "./map.ts";
import { mapPermission } from "./map.ts";
import type {
  Envelope,
  Info,
  RawDiff,
  RawPart,
  RawPermission,
  Session,
} from "./types.ts";
import { Backoff, Watchdog } from "./watchdog.ts";
import { TaskProgress } from "./tasks.ts";
import { parseDiff } from "../../content/diff.ts";
import { mapPromptParts } from "./prompt.ts";
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
export class Opencode1Adapter implements HarnessAdapter {
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
  #controller?: AbortController;
  #run?: Promise<void>;
  #wake?: () => void;
  #db: BootstrapDb;
  #tasks: TaskProgress;
  #reverts = new Map<string, string>();
  constructor(
    readonly cfg: ServiceConfig,
    readonly buffers = new StreamBuffers(),
    fetcher = fetch,
  ) {
    this.client = new Client(cfg.harness, fetcher);
    this.#db = new BootstrapDb(harnessDb(cfg));
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
        if (!cutoff || messageID < cutoff) {
          this.#sink.content(parent, { op: "part.upsert", messageID, part });
        }
      },
      () => this.#sink.resync("all"),
    );
  }
  start(sink: HarnessSink): Promise<void> {
    this.#sink = sink;
    this.#stopped = false;
    sink.connection("connecting");
    this.#run = this.#loop();
    return Promise.resolve();
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#controller?.abort();
    this.#wake?.();
    this.buffers.stop();
    this.#tasks.release();
    await this.#run;
    this.#db.close();
  }
  subscriptions(id: string, count: number): void {
    this.buffers.subscriptions(id, count);
    if (!count) this.#tasks.release(id);
    if (!count) this.#reverts.delete(id);
  }
  #directory(id: string): string | undefined {
    return this.#entries.get(id)?.directory;
  }
  async getSession(id: string): Promise<ContentSession> {
    const raw = await this.client.json<Session>(
      `/session/${encodeURIComponent(id)}`,
      {
        query: { directory: this.#directory(id) },
      },
    );
    return { ...mapSession(raw), revert: await this.#revertInfo(raw) };
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
  async #agentColors(directory?: string): Promise<Map<string, string>> {
    const agents = await this.client.json<{ name: string; color?: string }[]>(
      "/agent",
      { query: { directory } },
    );
    return new Map(agents.flatMap((agent) => {
      const color = agent.color &&
          /^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(agent.color)
        ? agent.color
        : agent.color === "primary"
        ? "var(--accent)"
        : agent.color === "secondary"
        ? "var(--secondary)"
        : undefined;
      return color ? [[agent.name, color]] : [];
    }));
  }
  async listMessages(
    id: string,
    opts: { before?: string; limit: number },
  ): Promise<Message[]> {
    // OTK's before is the oldest displayed message ID (M2). Resolve its time
    // per request and keep opencode's encoded cursor entirely in this adapter.
    const session = await this.client.json<Session>(
      `/session/${encodeURIComponent(id)}`,
      { query: { directory: this.#directory(id) } },
    );
    const cursor = session.revert &&
        (!opts.before || opts.before >= session.revert.messageID)
      ? session.revert.messageID
      : opts.before;
    let before: string | undefined;
    if (cursor) {
      const message = await this.client.json<{ info: Info; parts: RawPart[] }>(
        `/session/${encodeURIComponent(id)}/message/${
          encodeURIComponent(cursor)
        }`,
        { query: { directory: this.#directory(id) } },
      );
      before = btoa(
        JSON.stringify({
          id: message.info.id,
          time: message.info.time.created,
        }),
      )
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    }
    const raw = await this.client.json<{ info: Info; parts: RawPart[] }[]>(
      `/session/${encodeURIComponent(id)}/message`,
      {
        query: {
          directory: this.#directory(id),
          limit: opts.limit,
          before,
        },
      },
    );
    const colors = await this.#agentColors(session.directory);
    return Promise.all(raw.map(async (message) => {
      const mapped = mapMessage(message.info, message.parts);
      mapped.agentColor = colors.get(message.info.agent);
      for (const [i, part] of message.parts.entries()) {
        if (part.type === "tool" && part.tool === "task") {
          mapped.parts[i] = {
            kind: "tool",
            id: part.id,
            call: await this.#tasks.shape(part),
          };
        }
      }
      return mapped;
    }));
  }
  async listChildren(id: string): Promise<ContentSession[]> {
    const raw = await this.client.json<Session[]>(
      `/session/${encodeURIComponent(id)}/children`,
      { query: { directory: this.#directory(id) } },
    );
    return raw.map(mapSession).sort((a, b) => a.id.localeCompare(b.id));
  }
  async createSession(
    input: { directory: string; title?: string; parentID?: string },
  ): Promise<ContentSession> {
    const { directory, ...body } = input;
    return mapSession(
      await this.client.json<Session>("/session", {
        method: "POST",
        query: { directory },
        body,
      }),
    );
  }
  async prompt(input: PromptInput): Promise<void> {
    const directory = this.#directory(input.sessionID) ??
      (await this.getSession(input.sessionID)).directory;
    await this.client.request(
      `/session/${encodeURIComponent(input.sessionID)}/prompt_async`,
      {
        method: "POST",
        query: { directory },
        body: {
          parts: await mapPromptParts(input.parts, directory),
          variant: input.variant,
          agent: input.agent,
          model: input.model
            ? { providerID: input.model.provider, modelID: input.model.model }
            : undefined,
        },
      },
    );
  }
  async findFiles(sessionID: string, query: string): Promise<string[]> {
    const directory = this.#directory(sessionID) ??
      (await this.getSession(sessionID)).directory;
    return this.client.json<string[]>("/find/file", {
      query: { directory, query, dirs: "true", limit: 100 },
    });
  }
  async abort(id: string): Promise<void> {
    await this.client.json(`/session/${encodeURIComponent(id)}/abort`, {
      method: "POST",
      query: { directory: this.#directory(id) },
    });
  }
  async revert(id: string, messageID: string): Promise<ContentSession> {
    await this.client.json(`/session/${encodeURIComponent(id)}/revert`, {
      method: "POST",
      query: { directory: this.#directory(id) },
      body: { messageID },
    });
    return this.getSession(id);
  }
  async replyPermission(input: PermissionReply): Promise<void> {
    await this.client.json(
      `/permission/${encodeURIComponent(input.requestID)}/reply`,
      {
        method: "POST",
        query: { directory: this.#directory(input.sessionID) },
        body: { reply: input.reply, message: input.message },
      },
    );
  }
  async listPermissions(sessionID: string): Promise<PermissionRequest[]> {
    const directory = this.#directory(sessionID) ??
      (await this.getSession(sessionID)).directory;
    const pending = await this.client.json<RawPermission[]>("/permission", {
      query: { directory },
    });
    return pending.filter((request) =>
      belongsToSession(
        request.sessionID,
        sessionID,
        (id) => this.#entries.get(id),
      )
    )
      .map((request) =>
        mapPermission(request, this.#permissions.get(request.id)?.time)
      );
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
        entries.set(session.id, mapIndex(session));
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
    const { type, properties: p } = event.payload;
    // The 1.x bridge emits both the legacy event and its durable "sync"
    // companion. The latter has syncEvent, not properties; do not apply twice.
    if (!contentEvents.has(type)) {
      console.debug(`harness event ignored: ${type}`);
      return;
    }
    if (!p) throw new Error(`Malformed ${type} event: properties missing`);
    if (type === "server.instance.disposed") {
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
      if (old) {
        mapped.status = old.status;
        mapped.retry = old.retry;
        mapped.attention = old.attention;
      }
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
      this.#entries.delete(id);
      this.#sink.indexRemove(id);
      this.#attention();
      this.buffers.removeSession(id);
      return;
    }
    if ((type === "session.status" || type === "session.idle") && entry) {
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
      entry.status = status.type as IndexEntry["status"];
      entry.retry = entry.status === "retry"
        ? {
          attempt: status.attempt!,
          message: status.message!,
          next: status.next!,
        }
        : undefined;
      if (entry.status === "busy") delete entry.attention.error;
      this.#sink.indexUpsert(entry);
      return;
    }
    if (type === "session.error" && entry) {
      entry.attention.error = (p.error as Info["error"])?.data.message ||
        "Harness error";
      this.#sink.indexUpsert(entry);
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
    }
    if (type === "question.replied" || type === "question.rejected") {
      this.#questions.delete(String(p.requestID));
      this.#attention();
    }
    if (
      type === "message.updated" && info?.role === "assistant" &&
      info.time.completed && entry
    ) {
      entry.timeUpdated = Math.max(entry.timeUpdated, info.time.completed);
      this.#sink.indexUpsert(entry);
      this.buffers.complete(info.id, (id, op) => this.#sink.content(id, op));
    }
    if (type === "message.updated" || type === "message.part.updated") {
      this.#tasks.observe(sessionID, info, raw);
    }
    if (!this.buffers.subscribed(sessionID)) return;
    const cutoff = this.#reverts.get(sessionID),
      messageID = info?.id || raw?.messageID || String(p.messageID || "");
    if (cutoff && messageID && messageID >= cutoff) return;
    const content = (op: ContentOp) => this.#sink.content(sessionID, op);
    switch (type) {
      case "message.updated":
        {
          const message = mapMessage(info!),
            colors = await this.#agentColors(this.#directory(sessionID));
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
        const part = mapPart(raw, waiting);
        if (part.kind === "tool" && raw.tool === "task") {
          part.call = await this.#tasks.shape(raw);
        }
        content({ op: "part.upsert", messageID: raw.messageID, part });
        if (
          (part.kind === "text" || part.kind === "reasoning") &&
          raw.time?.start !== undefined &&
          raw.time?.end === undefined
        ) {
          this.buffers.upsert(sessionID, raw.messageID, part, raw.text || "");
        } else this.buffers.remove(raw.id);
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
            content({
              op: "part.upsert",
              messageID: String(p.messageID),
              part: mapPart(current),
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
