// SPDX-License-Identifier: LGPL-3.0-only
import type { HarnessCore } from "@otk/harness";
import type { ContentSession } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { Session } from "./types.ts";
import { mapSession } from "./map.ts";
import { opencodeV1SessionID as ids } from "./ids.ts";
import type { Transcript } from "./transcript.ts";

export function sessions(
  client: Client,
  directory: Directory,
  lifecycle: Pick<
    HarnessCore,
    "kind" | "version" | "start" | "stop" | "subscriptions"
  >,
  transcript: Transcript,
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
    subscriptions: (id, count) => {
      ids.decode(id);
      lifecycle.subscriptions(id, count);
    },
    identities: (ids, signal) => directory.validate(ids, signal),
    getSession: (id, signal) => transcript.session(id, signal),
    listMessages: (id, opts, signal) =>
      transcript.page(id, opts.before, signal),
    async listChildren(id, signal): Promise<ContentSession[]> {
      const raw = await client.json<Session[]>(
        `/session/${encodeURIComponent(ids.decode(id))}/children`,
        { query: { directory: directory.cached(id) }, signal },
      );
      return raw.map(mapSession).sort((a, b) => a.id.localeCompare(b.id));
    },
    async createSession(input, operation): Promise<ContentSession> {
      const { directory, parentID, ...rest } = input;
      const body = {
        ...rest,
        ...(parentID === undefined ? {} : { parentID: ids.decode(parentID) }),
      };
      return mapSession(
        await client.json<Session>("/session", {
          method: "POST",
          ...(operation
            ? { classification: "effect" as const, operation }
            : {}),
          query: { directory },
          body,
        }),
      );
    },
  };
}
