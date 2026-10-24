// SPDX-License-Identifier: LGPL-3.0-only
import type { HarnessCore } from "@otk/harness";
import {
  type ContentSession,
  type Message,
  sessionErrorMessage,
  type SessionErrorState,
} from "@otk/protocol";
import type { StreamBuffers } from "@otk/content";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { Info, RawPart, Session } from "./types.ts";
import { mapMessage, mapSession } from "./map.ts";
import type { TaskProgress } from "./tasks.ts";
import type { AgentColors } from "./agents.ts";
import type { RevertInfo } from "@otk/protocol";
import type { Messages } from "./messages.ts";

export function sessions(
  client: Client,
  directory: Directory,
  buffers: StreamBuffers,
  tasks: TaskProgress,
  reader: Messages,
  lifecycle: Pick<
    HarnessCore,
    "kind" | "version" | "start" | "stop" | "subscriptions"
  >,
  revertInfo: (raw: Session) => Promise<RevertInfo | undefined>,
  errors: (id: string) => SessionErrorState,
  agentColors: AgentColors,
): HarnessCore {
  return {
    get kind() {
      return lifecycle.kind;
    },
    get version() {
      return lifecycle.version;
    },
    start: (sink) => lifecycle.start(sink),
    stop: () => lifecycle.stop(),
    subscriptions: (id, count) => lifecycle.subscriptions(id, count),
    async getSession(id): Promise<ContentSession> {
      const raw = await client.json<Session>(
        `/session/${encodeURIComponent(id)}`,
        { query: { directory: directory.cached(id) } },
      );
      const revert = await revertInfo(raw);
      const errorState = errors(id);
      return {
        ...mapSession(raw),
        revert,
        error: sessionErrorMessage(errorState),
        errorState,
      };
    },
    async listMessages(id, opts): Promise<Message[]> {
      // Resolve OTK's oldest displayed ID into the native encoded cursor here.
      const session = await client.json<Session>(
        `/session/${encodeURIComponent(id)}`,
        { query: { directory: directory.cached(id) } },
      );
      const cursor = session.revert &&
          (!opts.before || opts.before >= session.revert.messageID)
        ? session.revert.messageID
        : opts.before;
      let before: string | undefined;
      if (cursor) {
        const message = await client.json<{ info: Info; parts: RawPart[] }>(
          `/session/${encodeURIComponent(id)}/message/${
            encodeURIComponent(cursor)
          }`,
          { query: { directory: directory.cached(id) } },
        );
        before = btoa(
          JSON.stringify({
            id: message.info.id,
            time: message.info.time.created,
          }),
        ).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      }
      const { items: raw } = await reader.page(id, opts.limit, before);
      const colors = agentColors.peek(
        session.directory,
        buffers.subscribed(id) ? id : undefined,
      );
      const messages = await Promise.all(raw.map(async (message) => {
        const mapped = mapMessage(message.info, message.parts);
        if (mapped.agent !== undefined) {
          mapped.agentColor = colors?.get(mapped.agent);
        }
        for (const [i, part] of message.parts.entries()) {
          if (part.type === "tool" && part.tool === "task") {
            mapped.parts[i] = {
              kind: "tool",
              id: part.id,
              call: await tasks.shape(part),
            };
          }
        }
        return mapped;
      }));
      return messages.map((message) => buffers.overlay(message));
    },
    async listChildren(id): Promise<ContentSession[]> {
      const raw = await client.json<Session[]>(
        `/session/${encodeURIComponent(id)}/children`,
        { query: { directory: directory.cached(id) } },
      );
      return raw.map(mapSession).sort((a, b) => a.id.localeCompare(b.id));
    },
    async createSession(input): Promise<ContentSession> {
      const { directory, ...body } = input;
      return mapSession(
        await client.json<Session>("/session", {
          method: "POST",
          query: { directory },
          body,
        }),
      );
    },
  };
}
