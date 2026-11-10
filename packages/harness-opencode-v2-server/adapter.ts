// SPDX-License-Identifier: LGPL-3.0-only
import {
  type Harness,
  type HarnessCore,
  HarnessError,
  type HarnessSink,
  SessionIndex,
} from "@otk/harness";
import type { Capabilities, SessionMetadata } from "@otk/protocol";
import { type DiscoveredService, discoverV2 } from "./discovery.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { type V2Event, V2Stream } from "./stream.ts";
import {
  type OpenCodeClient,
  type V2Client,
  V2MissingSession,
} from "./client.ts";
import { Transcript } from "./transcript.ts";
import type { DigestPort } from "@otk/harness";
import { mapSession as session, millis } from "./map.ts";
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
  attachments?: import("@otk/protocol").AttachmentPolicy;
}
type NativeSession = Awaited<ReturnType<OpenCodeClient["session"]["get"]>>;
type Pending = {
  id: string;
  sessionID: string;
  kind: "permission" | "form";
  directory: string;
};
/** V0 supplies the connection owner. Capabilities are added only with their proofs. */
export class OpencodeV2ServerAdapter implements Harness {
  readonly core: HarnessCore;
  readonly capabilities: Readonly<Capabilities>;
  readonly stream: V2Stream;
  readonly transcript: Transcript;
  #sink?: HarnessSink;
  #index = new SessionIndex();
  #pending = new Map<string, Pending>();
  #running = new Map<string, number>();
  #version = "";
  #generation = 0;
  #helperListener?: () => void;
  constructor(
    readonly config: OpencodeV2ServerConfig,
    initial?: DiscoveredService,
    readonly diagnostic: (error: unknown) => void = () => {},
    fetcher: typeof fetch = fetch,
    readonly digest?: DigestPort,
  ) {
    this.#version = initial?.version ?? "";
    this.stream = new V2Stream(
      {
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
          this.#version = client.service.version;
          this.#generation = generation;
          this.#sink?.connection("connected");
          this.#sink?.bootstrapComplete();
        },
        disconnected: (generation) => {
          this.transcript.disconnect();
          this.#generation = generation;
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
    this.capabilities = Object.freeze(
      {
        commands: commands(() => this.stream.client, config.attachments),
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
        ...(digest
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
          : {}),
      },
    );
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
          this.#sink = undefined;
          throw error;
        }
      },
      stop: async () => {
        // Retire the publication port synchronously before joining any read.
        this.#sink = undefined;
        this.#helperListener?.();
        this.#helperListener = undefined;
        await this.stream.stop();
        await this.transcript.stop();
        await digest?.stop();
        this.#pending.clear();
        this.#running.clear();
      },
      subscriptions: (id, count) => this.transcript.subscriptions(id, count),
      hydrate: async (keys, signal) => {
        await digest?.hydrate?.(keys, signal ?? new AbortController().signal);
      },
      identities: async (keys, signal) => {
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
      listSessions: unavailable,
      listChildren: unavailable,
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
  async #deleted(
    id: string,
    metadata: SessionMetadata | undefined,
    generation: number,
  ): Promise<void> {
    if (generation !== this.#generation) return;
    this.transcript.release(id);
    this.#running.delete(ids.decode(id));
    for (const [key, pending] of this.#pending) {
      if (pending.sessionID === ids.decode(id)) this.#pending.delete(key);
    }
    if (this.digest) {
      await this.digest.deleted(generation, id, Date.now(), metadata);
    } else {
      if (!this.#sink?.index) this.#index.remove(id);
      this.#sink?.indexRemove(id);
    }
  }
  #metadata(raw: NativeSession, busy: boolean): SessionMetadata {
    const mapped = session(raw);
    const pending = [...this.#pending.values()].filter((p) =>
      p.sessionID === raw.id
    );
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
      attention: {
        permissions: pending.filter((p) => p.kind === "permission").length,
        questions: pending.filter((p) => p.kind === "form").length,
        childPermissions: 0,
        childQuestions: 0,
      },
    };
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
    const pending = new Map(this.#pending);
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
      try {
        const permissions = await client.read(
          (api) =>
            api.permission.request.list({
              location,
            }, { signal }),
          signal,
        );
        const forms = await client.read(
          (api) => api.form.list({ location }, { signal }),
          signal,
        );
        signal.throwIfAborted();
        // Replace only after both complete owner/location inventories succeed.
        for (const [key, value] of pending) {
          if (value.directory === location.directory) pending.delete(key);
        }
        for (
          const [kind, rows] of [["permission", permissions.data], [
            "form",
            forms.data,
          ]] as const
        ) {
          for (const row of rows) {
            pending.set(`${kind}:${row.id}`, {
              id: row.id,
              sessionID: row.sessionID,
              kind,
              directory: location.directory,
            });
            if (row.sessionID !== "global") owners.add(row.sessionID);
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        this.diagnostic(error);
      }
    }
    const sessions: NativeSession[] = [];
    for (const id of owners) {
      try {
        sessions.push(
          await client.read(
            (api) => api.session.get({ sessionID: id }, { signal }),
            signal,
          ),
        );
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
      this.#pending = pending;
      if (reconnect) {
        await transcriptCommit?.();
      }
      this.#sink?.projectAuthority?.("unknown");
      for (const raw of sessions) {
        const previous = this.#running.get(raw.id);
        if (active[raw.id]) this.#running.set(raw.id, millis(raw.time.busy));
        else this.#running.delete(raw.id);
        const entry = this.#metadata(raw, !!active[raw.id]);
        // An old outcome cannot certify a lost newer execution's success.
        if (
          previous !== undefined && !active[raw.id] &&
          millis(raw.time.idle) < previous
        ) {
          entry.attention.error =
            "Execution continuity was interrupted; its outcome is unknown.";
        }
        this.#upsert(entry);
      }
    };
  }
  async #event(
    event: V2Event,
    client: V2Client,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
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
    const form = event.data.form;
    const sid = event.data.sessionID ??
      (form && typeof form === "object"
        ? Reflect.get(form, "sessionID")
        : undefined);
    if (typeof sid !== "string" || sid === "global") return;
    if (
      !/^session\.execution\./.test(event.type) &&
      !/^(permission\.|form\.)/.test(event.type) &&
      !/^session\.(created|forked|renamed|archived|unarchived|metadata.updated)$/
        .test(event.type)
    ) return;
    if (event.type === "session.execution.started") {
      this.#running.set(sid, event.created ?? Date.now());
    } else if (
      /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)
    ) this.#running.delete(sid);
    if (/^(permission\.|form\.)/.test(event.type)) {
      // Inventory is the authoritative reconciliation for racing ephemeral requests.
      const commit = await this.#resync(client, signal, generation, false);
      signal.throwIfAborted();
      await commit();
      return;
    }
    const raw = await client.read(
      (api) => api.session.get({ sessionID: sid }, { signal }),
      signal,
    );
    signal.throwIfAborted();
    if (generation !== this.#generation) return;
    // An API snapshot may already cover a buffered execution edge. Native busy
    // and idle clocks prevent an older frame from reopening a completed run or
    // settling a newer one. Session.outcome alone is never continuity proof.
    const busy = millis(raw.time.busy), idle = millis(raw.time.idle);
    if (
      event.type === "session.execution.started" &&
      idle >= (event.created ?? busy)
    ) this.#running.delete(sid);
    if (
      event.type !== "session.execution.started" &&
      busy > (event.created ?? 0) && busy > idle
    ) this.#running.set(sid, busy);
    this.#upsert(this.#metadata(raw, this.#running.has(sid)));
  }
}
