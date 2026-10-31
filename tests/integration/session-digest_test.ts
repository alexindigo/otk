// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createIndex } from "@otk/client";
import type { InboxSnapshot, IndexEntry, TaskRecord } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

test("shipped source rebuilds only derived digests and serves cached deleted metadata and seen marks without provider health", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const session = await oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Derived rebuild" },
  });
  const state = join(oc.root, "digest-state");
  const run = async () => {
    const server = await SidecarTest.start(oc, { state: { path: state } });
    const client = new WsClient(server.url);
    await client.connect();
    const index = createIndex();
    let cursor = 0;
    const entry = () => {
      for (const frame of client.frames.slice(cursor)) {
        if (frame.t === "index.snapshot" || frame.t === "index.patch") {
          assertEquals(index.receive("source", frame), true);
        }
      }
      cursor = client.frames.length;
      return index.state.entries[`source/${session.id}`] as
        | IndexEntry
        | undefined;
    };
    return {
      client,
      entry,
      stop: async () => {
        await client.close();
        await server.stop();
      },
    };
  };
  let task: TaskRecord;
  let seenClock = 0;
  const first = await run();
  try {
    await waitFor(first.entry, (entry) => entry?.digest.state === "ready");
    task = await first.client.rpc<TaskRecord>("tasks.create", {
      directory: oc.directory,
      name: "Keep user data",
      sessions: [session.id],
    });
    seenClock = await first.client.rpc<number>("sessions.seen", {
      sessionID: session.id,
    });
    fake.queue({ chunks: ["Source digest reply"] });
    await oc.request(`/session/${session.id}/message`, {
      method: "POST",
      body: {
        model: { providerID: "fake", modelID: "scripted" },
        parts: [{ type: "text", text: "Source digest prompt" }],
      },
    });
    await waitFor(
      first.entry,
      (entry) =>
        entry?.digest.state === "ready" && (entry.digest.total?.calls ?? 0) > 0,
    );
  } finally {
    await first.stop();
  }
  for (const file of ["digest.db", "digest.db-wal", "digest.db-shm"]) {
    try {
      await Deno.remove(join(state, file));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  assertEquals((await Deno.stat(join(state, "otk.db"))).isFile, true);
  const rebuilt = await run();
  try {
    await waitFor(
      rebuilt.entry,
      (entry) =>
        entry?.digest.state === "ready" && (entry.digest.total?.calls ?? 0) > 0,
    );
    assertEquals(
      (await rebuilt.client.rpc<TaskRecord[]>("tasks.list", {})).find((row) =>
        row.id === task.id
      )?.sessions,
      [session.id],
    );
    assertEquals(
      (await rebuilt.client.rpc<{ inbox: InboxSnapshot }>("inbox.get", {}))
        .inbox.seen[session.id],
      seenClock,
    );
    await oc.request(`/session/${session.id}`, { method: "DELETE" });
    await waitFor(rebuilt.entry, (entry) => entry?.deleted?.how === "provider");
  } finally {
    await rebuilt.stop();
  }
  await oc.stop();
  const offline = await run();
  try {
    await waitFor(offline.entry, (entry) => entry?.deleted?.how === "provider");
    assertEquals(offline.entry()!.digest.total!.calls > 0, true);
    const seen = await offline.client.rpc<number>("sessions.seen", {
      sessionID: session.id,
    });
    assertEquals(seen > 0, true);
    assertEquals(
      (await offline.client.rpc<TaskRecord[]>("tasks.list", {})).find((row) =>
        row.id === task.id
      )?.sessions,
      [session.id],
    );
  } finally {
    await offline.stop();
  }
});
