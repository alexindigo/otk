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
      idlems: 1,
      parallel: 3,
      background: false,
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
        !paused && turns.length
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
    bridge.scope("viewer", { sessions: [] });
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

test("fresh catalog replacement preserves tombstones during keyed retained hydration", async () => {
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
      idlems: 1,
      parallel: 3,
      background: false,
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
    first.scope("viewer", { sessions: [] });
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
    restarted.scope("viewer", { sessions: [] });
    await restarted.start();
    // Q1 has no startup replay; acquire the exact retained keys before replacing their publication.
    await restarted.hydrate(
      entries.map((entry) => `opcv1-${entry.id}`),
      controller.signal,
      true,
    );
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

for (const background of [false, true]) {
  test(`explicit cached replay follows background=${background}; deletion donates only to its ordered predecessor`, async () => {
    const root = await tempDir("digest-donation-");
    const entries = ["a", "b"].map((id) => ({
      id: `ses_${id}`,
      projectID: "p",
      directory: "/p",
      title: id,
      time: { created: 1, updated: 2 },
    }));
    const native = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/global/health") return Response.json({ healthy: true });
        if (path === "/experimental/session") return Response.json(entries);
        const id = path.split("/")[2];
        return Response.json(Array.from({ length: 100 }, (_, i) => ({
          info: {
            id: `msg_${i}`,
            sessionID: id,
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
      },
    );
    resources().defer("donation native", () => native.shutdown());
    const settings = cfg();
    settings.harness.url = `http://127.0.0.1:${native.addr.port}`;
    settings.harness.db = root + "/absent.db";
    const options = {
      statePath: root,
      provider: "opencode-v1",
      native: settings,
      policy: {
        ...settings.digest,
        background,
        batch: 200,
        publishrows: 1,
        cpu: 1,
        memoryreserve: 1,
      },
    };
    const ready = new Set<string>();
    const first = new DigestBridge({
      ...options,
      publish: (value) => {
        if (value.delta.summary.state === "ready") ready.add(value.sessionID);
      },
    });
    first.scope("seed", { sessions: [] });
    try {
      await first.catalog(1, new AbortController().signal);
      await waitFor(() => ready.size, (n) => n === 2);
    } finally {
      await first.stop();
    }
    const seen: string[] = [];
    let closed = false;
    let pressure:
      | import("../../../core/digest/protocol.ts").DigestPressure
      | undefined;
    const restarted = new DigestBridge({
      ...options,
      pressure: (value) => pressure = value,
      publish: (value) => {
        for (const _turn of Object.keys(value.delta.turns.upsert)) {
          seen.push(value.sessionID);
        }
        if (value.delta.deleted) seen.push("deleted:" + value.sessionID);
        if (!closed && seen.length) {
          closed = true;
          // Begin observing at release, not after its acknowledgement: the
          // worker may publish its final drained frame before that fence returns.
          pressure = undefined;
          restarted.release("viewer");
        }
      },
    });
    restarted.scope("viewer", { sessions: [] });
    try {
      await restarted.start();
      // Q1 never launches population replay at startup; this explicit compatibility catalog owns it.
      await restarted.catalog(1, new AbortController().signal);
      await waitFor(() => closed, Boolean);
      if (background) {
        await waitFor(() => seen.length, (n) => n === 200);
        assertEquals(seen.filter((id) => id === "opcv1-ses_a").length, 100);
        assertEquals(seen.filter((id) => id === "opcv1-ses_b").length, 100);
        await restarted.deleted(1, "opcv1-ses_a", 1);
        assertEquals(seen.at(-1), "deleted:opcv1-ses_a");
        return;
      }
      // Fence receipt of the scope release, then observe a fresh drained state;
      // a pressure frame sent before the first publication is not pause evidence.
      await restarted.deleteIntent("opcv1-ses_b", "fence", "begin", 1);
      await waitFor(
        () => pressure,
        (value) =>
          closed && value?.active === 0 && value.heldCredits === 0 &&
          value.publicationWaiting === 0,
      );
      const paused = [...seen];
      // Socket release crosses an isolate boundary: one already-started credited
      // chunk may settle after the callback closes the final viewer.
      assertEquals(paused.every((id) => id === "opcv1-ses_a"), true);
      assertEquals(paused.length >= 1 && paused.length <= 2, true);
      await restarted.deleteIntent("opcv1-ses_b", "barrier", "begin", 1);
      assertEquals(
        seen,
        paused,
        "An essential turn must not resume unrelated optional chunks",
      );
      await bounded(
        "deletion priority donation",
        restarted.deleted(1, "opcv1-ses_a", 1),
        5000,
      );
      assertEquals(seen, [
        ...Array.from({ length: 100 }, () => "opcv1-ses_a"),
        "deleted:opcv1-ses_a",
      ]);
      await restarted.deleteIntent("opcv1-ses_b", "barrier", "failed", 1);
      assertEquals(seen.includes("opcv1-ses_b"), false);
      restarted.scope("reconnected", { sessions: [] });
      await waitFor(
        () => seen.filter((id) => id === "opcv1-ses_b").length,
        (n) => n === 100,
      );
    } finally {
      await restarted.stop();
    }
  });
}
