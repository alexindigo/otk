// SPDX-License-Identifier: LGPL-3.0-only
import {
  entityKey,
  type InboxBaseline,
  taskEntityID,
  type TaskRecord,
} from "@otk/protocol";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { waitFor } from "./opencode.ts";
import { resources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";

/** A deeply nested task for the independent component consumer. Supply native
 * facts only; the real inbox owner publishes membership and helper verdicts. */
export async function styleListScene(root: string) {
  const f = await inboxBrowserFixture(root);
  const base = f.entries[0];
  const entries = Array.from({ length: 10 }, (_, n) => ({
    ...base,
    id: `tstv1-session-${n}`,
    title: `session-${n}`,
    parentID: n ? `tstv1-session-${n - 1}` : undefined,
    status: "busy" as const,
  }));
  for (const entry of entries) f.add(entry);
  const client = new WsClient(f.url);
  resources().defer("style list client", () => client.close());
  client.lease({
    directory: base.directory,
    selected: entries.at(-1)!.id,
    crumbs: entries.slice(0, -1).map(({ id }) => id),
    rows: [],
  });
  await client.connect();
  const task = await client.rpc<TaskRecord>("tasks.create", {
    directory: base.directory,
    name: "Task",
    sessions: [entries[0].id],
  });
  const key = entityKey("task", taskEntityID("task", task.id));
  const { inbox } = await waitFor(
    () => client.rpc<InboxBaseline>("inbox.get", {}),
    ({ inbox }) => inbox.entities?.[key]?.helpers?.counts.running === 9,
  );
  return { entries, inbox };
}
