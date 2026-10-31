// SPDX-License-Identifier: LGPL-3.0-only
import { cfg } from "../../support/config.ts";
import { assertEquals } from "@std/assert";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import { bounded, resources, tempDir, test } from "../../support/resources.ts";
import { waitFor } from "../../support/opencode.ts";

test("interactive reads cannot pause an ordered publication needed by a newer deletion", async () => {
  const root = await tempDir("digest-priority-");
  const native = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/global/health") return Response.json({ healthy: true });
      if (path === "/experimental/session") {
        return Response.json([{
          id: "ses_one",
          projectID: "p",
          directory: "/p",
          title: "One",
          time: { created: 1, updated: 2 },
        }]);
      }
      if (path === "/session/ses_one/message") {
        return Response.json(Array.from({ length: 8 }, (_, i) => ({
          info: {
            id: `msg_${i}`,
            sessionID: "ses_one",
            parentID: `turn_${i}`,
            role: "assistant",
            agent: "build",
            providerID: "p",
            modelID: "m",
            time: { created: i + 1, completed: i + 2 },
            cost: 0,
            tokens: {
              input: 1,
              output: 1,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [],
        })));
      }
      return new Response("Unexpected priority fixture request", {
        status: 500,
      });
    },
  );
  resources().defer("priority fixture HTTP", () => native.shutdown());
  const entered = Promise.withResolvers<void>();
  const seen: { revision: number; deleted: boolean; turns: string[] }[] = [];
  let paused = false;
  const bridge = new DigestBridge({
    statePath: root,
    provider: "opencode-v1",
    native: {
      harness: {
        url: `http://127.0.0.1:${native.addr.port}`,
        db: root + "/absent.db",
        username: "",
        password: "",
        heartbeattimeout: 25,
        reconnectmax: 30,
        requestms: 60000,
      },
      index: { days: 30 },
      attachments: cfg().attachments,
    },
    policy: {
      batch: 10,
      slicems: 8,
      cpu: 1,
      memoryreserve: 1,
      maxpending: 128,
      publishrows: 1,
      retryms: 10,
      busyms: 100,
    },
    publish: (value) => {
      const turns = Object.keys(value.delta.turns.upsert);
      seen.push({
        revision: value.revision,
        deleted: value.delta.deleted !== null,
        turns,
      });
      if (
        !paused && turns.length && value.delta.summary.state === "digesting"
      ) {
        paused = true;
        // Hold interactive pressure after the first chunk of a larger-than-credit
        // publication. Its ordered successor must finish without releasing this.
        bridge.interactive("held-read", true);
        entered.resolve();
      }
    },
  });
  const controller = new AbortController();
  try {
    await bridge.start();
    await bridge.catalog(1, controller.signal);
    await bounded("first multipart publication", entered.promise);
    await bounded(
      "ordered deletion during interactive pressure",
      bridge.deleted(1, "opcv1-ses_one", 1),
      2000,
    );
    assertEquals(seen.at(-1)!.deleted, true);
    assertEquals(
      seen.flatMap((value) => value.turns).sort(),
      Array.from({ length: 8 }, (_, i) => `turn_${i}`),
    );
    assertEquals(seen.every((value) => value.turns.length <= 1), true);
    assertEquals(
      seen.every((value, i) =>
        i === 0 || value.revision >= seen[i - 1].revision
      ),
      true,
    );
  } finally {
    bridge.interactive("held-read", false);
    controller.abort();
    await bridge.stop();
  }
});

test("fresh catalog replacement publishes tombstones left by a cancelled cached replay", async () => {
  const root = await tempDir("digest-replay-");
  const entries = Array.from({ length: 8 }, (_, i) => ({
    id: `ses_${i}`,
    projectID: "p",
    directory: "/p",
    title: `Retained ${i}`,
    time: { created: 1, updated: 2 },
  }));
  let present = true;
  const native = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/global/health") return Response.json({ healthy: true });
      if (path === "/experimental/session") {
        return Response.json(present ? entries : []);
      }
      return Response.json([]);
    },
  );
  resources().defer("cached replay fixture HTTP", () => native.shutdown());
  const options = {
    statePath: root,
    provider: "opencode-v1",
    native: {
      harness: {
        url: `http://127.0.0.1:${native.addr.port}`,
        db: root + "/absent.db",
        username: "",
        password: "",
        heartbeattimeout: 25,
        reconnectmax: 30,
        requestms: 60000,
      },
      index: { days: 30 },
      attachments: cfg().attachments,
    },
    policy: {
      batch: 10,
      slicems: 8,
      cpu: 1,
      memoryreserve: 1,
      maxpending: 128,
      publishrows: 1,
      retryms: 10,
      busyms: 100,
    },
  };
  const ready = new Set<string>();
  const first = new DigestBridge({
    ...options,
    publish: (value) => {
      if (value.delta.summary.state === "ready") ready.add(value.sessionID);
    },
  });
  const controller = new AbortController();
  try {
    await first.start();
    await first.catalog(1, controller.signal);
    await waitFor(() => ready.size, (n) => n === entries.length);
    for (const entry of entries) {
      await first.deleted(1, `opcv1-${entry.id}`, 1);
    }
  } finally {
    await first.stop();
  }
  present = false;
  const tombstones = new Set<string>();
  let replacement: ReturnType<DigestBridge["catalog"]> | undefined;
  const restarted = new DigestBridge({
    ...options,
    metadata: () => {
      // Replace replay at its first metadata seed, before all cached digest
      // chunks can arrive. Already-deleted rows do not change in this catalog.
      replacement ??= restarted.catalog(2, controller.signal);
    },
    publish: (value) => {
      if (value.delta.deleted) tombstones.add(value.sessionID);
    },
  });
  try {
    await restarted.start();
    assertEquals(replacement !== undefined, true);
    await bounded("replacement catalog", replacement!);
    await waitFor(() => tombstones.size, (n) => n === entries.length, 2000);
    assertEquals(
      [...tombstones].sort(),
      entries.map((entry) => `opcv1-${entry.id}`).sort(),
    );
  } finally {
    controller.abort();
    await restarted.stop();
  }
});
