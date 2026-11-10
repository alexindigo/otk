// SPDX-License-Identifier: LGPL-3.0-only
import type { V2Client } from "./client.ts";
import type { NativeSession } from "./metadata.ts";

export async function readSessionActivity(
  client: V2Client,
  sessionID: string,
  signal?: AbortSignal,
): Promise<NativeSession> {
  return await withSessionActivity(
    client,
    await client.read(
      (api) => api.session.get({ sessionID }, { signal }),
      signal,
    ),
    signal,
  );
}

const clocks = ["created", "busy", "idle"] as const;
const activityKinds = [
  "user",
  "assistant",
  "synthetic",
  "system",
  "skill",
  "shell",
  "compaction",
];
function time(value: unknown): number {
  const result = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Date.parse(value)
    : 0;
  return Number.isFinite(result) ? result : 0;
}
/** Session.Info busy/idle are execution clocks; generic updated is metadata.
 * Shell and imported message activity additionally comes from message clocks. */
export function sessionRecency(
  value: { created: unknown; busy?: unknown; idle?: unknown },
  message?: unknown,
): number {
  return Math.max(...clocks.map((key) => time(value[key])), time(message));
}
/** Same clock definition for worker-owned scalar SQL, including keyset ordering. */
export function sessionRecencySql(
  columns: ReadonlySet<string>,
  messages: boolean,
): string {
  const values = clocks.map((key) =>
    columns.has(`time_${key}`) ? `coalesce(s.time_${key},0)` : "0"
  );
  if (messages) {
    values.push(
      `coalesce((SELECT max(m.time_created,coalesce(json_extract(m.data,'$.time.completed'),0)) FROM session_message m WHERE m.session_id=s.id AND m.type IN (${
        activityKinds.map((kind) => `'${kind}'`).join(",")
      }) ORDER BY m.seq DESC LIMIT 1),0)`,
    );
  }
  return `max(${values.join(",")})`;
}
/** Native has no header-only or activity-sorted endpoint. Release each bounded
 * body page after extracting the newest non-control message's own clock. */
export async function withSessionActivity<
  T extends {
    id: string;
    time: { created: unknown; busy?: unknown; idle?: unknown };
  },
>(
  client: V2Client,
  raw: T,
  signal?: AbortSignal,
): Promise<T & { activity: number }> {
  let cursor: string | undefined;
  while (true) {
    signal?.throwIfAborted();
    const page = await client.read(
      (api) =>
        api.message.list({
          sessionID: raw.id,
          limit: 20,
          ...(cursor ? { cursor } : { order: "desc" }),
        }, { signal }),
      signal,
    );
    const message = page.data.find((row) => activityKinds.includes(row.type));
    if (message) {
      return {
        ...raw,
        activity: Math.max(
          time(message.time.created),
          time(
            "completed" in message.time ? message.time.completed : undefined,
          ),
        ),
      };
    }
    const next = page.cursor.next ?? undefined;
    if (!page.data.length || !next) return { ...raw, activity: 0 };
    if (cursor === next) {
      throw new Error("Native activity cursor did not advance");
    }
    cursor = next;
  }
}
