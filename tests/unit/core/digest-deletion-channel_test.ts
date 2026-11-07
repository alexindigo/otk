// SPDX-License-Identifier: LGPL-3.0-only
import { cfg } from "../../support/config.ts";
import { assertEquals } from "@std/assert";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import type { FromWorker, ToWorker } from "../../../core/digest/protocol.ts";
import { resources, tempDir, test } from "../../support/resources.ts";
import { waitFor } from "../../support/opencode.ts";

test("accepted deletions survive a worker restart, coalesce in bounded batches and keep current OTK intent authority without provider health", async () => {
  const root = await tempDir("deletion-channel-");
  let online = true;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/global/health") return Response.json({ healthy: online });
      if (path === "/experimental/session") {
        return Response.json(
          [0, 1, 2].map((n) => ({
            id: `ses_${n}`,
            directory: "/p",
            projectID: "p",
            title: `Session ${n}`,
            time: { created: 1, updated: 2 },
          })),
        );
      }
      return Response.json([]);
    },
  );
  resources().defer("deletion HTTP", () => server.shutdown());
  const OriginalWorker = globalThis.Worker;
  const active = new Set<number>();
  let maximum = 0, sent = 0, rows = 0, crashes = 0;
  class ObservedWorker extends OriginalWorker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      this.addEventListener("message", (event: MessageEvent<FromWorker>) => {
        if (event.data.t === "accepted") active.delete(event.data.id);
      });
    }
    override postMessage(value: unknown): void {
      const command = value as ToWorker;
      if (command.t === "deleted") {
        sent++;
        active.add(command.id);
        maximum = Math.max(maximum, active.size);
        const sessions = Reflect.get(command, "sessions");
        rows += Array.isArray(sessions) ? sessions.length : 1;
        assertEquals(!Array.isArray(sessions) || sessions.length <= 2, true);
      }
      super.postMessage(value);
    }
  }
  globalThis.Worker = ObservedWorker;
  const deleted = new Map<string, string>();
  const ready = new Set<string>();
  const options = {
    statePath: root,
    provider: "opencode-v1",
    native: {
      harness: {
        url: `http://127.0.0.1:${server.addr.port}`,
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
      batch: 2,
      slicems: 8,
      cpu: 1,
      memoryreserve: 1,
      maxpending: 2,
      idlems: 1,
      parallel: 3,
      background: false,
      publishrows: 2,
      retryms: 1000,
      busyms: 100,
    },
    publish: (value: import("@otk/harness").DigestPublication) => {
      if (value.delta.summary.state === "ready") ready.add(value.sessionID);
      if (value.delta.deleted) {
        deleted.set(value.sessionID, value.delta.deleted.how);
      }
    },
    diagnostic: () => {},
  };
  const bridge = new DigestBridge({
    ...options,
    unready: () => {
      crashes++;
      bridge.release("fault");
    },
  });
  try {
    bridge.scope("viewer", { sessions: [] });
    await bridge.catalog(1, new AbortController().signal);
    await waitFor(() => ready.size, (n) => n === 3);
    await bridge.deleteIntent("opcv1-ses_0", "owned", "begin", 1);
    Reflect.apply(bridge.scope, bridge, ["fault", { sessions: undefined }]);
    await waitFor(() => crashes, (n) => n === 1);
    online = false;
    await Promise.all(
      Array.from(
        { length: 1000 },
        (_, n) => bridge.deleted(1, `opcv1-ses_${n % 3}`, 9),
      ),
    );
    assertEquals([...deleted].sort(), [["opcv1-ses_0", "otk"], [
      "opcv1-ses_1",
      "provider",
    ], ["opcv1-ses_2", "provider"]]);
    assertEquals(maximum, 1);
    assertEquals(rows, 3);
    assertEquals(sent, 2);
    await bridge.stop();
    deleted.clear();
    const restarted = new DigestBridge(options);
    try {
      restarted.scope("viewer", { sessions: [] });
      await restarted.start();
      // Q1 replaces population replay with explicit retained-key acquisition, even offline.
      await restarted.hydrate(
        ["opcv1-ses_0", "opcv1-ses_1", "opcv1-ses_2"],
        new AbortController().signal,
        true,
      );
      await waitFor(() => deleted.size, (n) => n === 3);
      assertEquals(deleted.size, 3);
    } finally {
      await restarted.stop();
    }
  } finally {
    await bridge.stop();
    globalThis.Worker = OriginalWorker;
  }
});
