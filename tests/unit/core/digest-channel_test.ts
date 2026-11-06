// SPDX-License-Identifier: LGPL-3.0-only
import { cfg } from "../../support/config.ts";
import { assertEquals } from "@std/assert";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import type { FromWorker, ToWorker } from "../../../core/digest/protocol.ts";
import { resources, tempDir, test } from "../../support/resources.ts";
import { waitFor } from "../../support/opencode.ts";

test("dirty channel has one acknowledged batch in flight and retains full-session markers at the key budget", async () => {
  const statePath = await tempDir("digest-channel-");
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) =>
      Response.json(
        new URL(request.url).pathname === "/global/health"
          ? { healthy: true }
          : [],
      ),
  );
  resources().defer("channel fixture HTTP", () => server.shutdown());
  const OriginalWorker = globalThis.Worker;
  const active = new Set<number>();
  const sent: Extract<ToWorker, { t: "dirty" }>[] = [];
  let maximum = 0;
  class ObservedWorker extends OriginalWorker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      this.addEventListener("message", (event: MessageEvent<FromWorker>) => {
        if (event.data.t === "accepted") active.delete(event.data.id);
      });
    }
    override postMessage(value: unknown): void {
      const command = value as ToWorker;
      if (command.t === "dirty") {
        sent.push(structuredClone(command));
        active.add(command.id);
        maximum = Math.max(maximum, active.size);
      }
      super.postMessage(value);
    }
  }
  globalThis.Worker = ObservedWorker;
  const bridge = new DigestBridge({
    statePath,
    provider: "opencode-v1",
    native: {
      harness: {
        url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
        db: statePath + "/absent.db",
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
      publishrows: 2,
      retryms: 10,
      busyms: 100,
    },
    publish: () => {},
  });
  try {
    bridge.scope("viewer", { sessions: [] });
    await bridge.start();
    await bridge.catalog(1, new AbortController().signal);
    bridge.observe(
      1,
      Array.from(
        { length: 20 },
        (_, index) => ({
          sessionID: `opcv1-ses_${index}`,
          revision: 1,
          reason: "messages",
          messages: ["a", "b"],
        }),
      ),
    );
    await waitFor(
      () => sent.reduce((count, command) => count + command.sessions.length, 0),
      (count) => count === 20,
    );
    assertEquals(maximum, 1);
    assertEquals(
      sent.flatMap((command) => command.sessions).every((entry) =>
        entry.messages === undefined
      ),
      true,
    );
  } finally {
    try {
      await bridge.stop();
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  }
});
