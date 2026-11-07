// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { DigestScheduler } from "@otk/harness";
import { digestProgressSource } from "../../core/features/digest-progress.ts";
import { cfg, fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { resources, test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

for (
  const outcome of [
    "accepted",
    "empty",
    "failed",
    "superseded",
    "cancelled",
  ] as const
) {
  test(`@load @transport first page ${outcome} fences optional admission without holding essential work`, async () => {
    const seen: string[] = [];
    const scheduler = new DigestScheduler({ ...cfg().digest, cpu: 1 }, {
      freeMemory: () => Number.MAX_SAFE_INTEGER,
      sleep: () => Promise.resolve(),
    });
    scheduler.viewers(false);
    resources().defer("first page scheduler", () => scheduler.stop());
    scheduler.register({
      identity: "test-v1",
      catalog: () => Promise.resolve({ entries: [], authoritative: true }),
      detail: () => Promise.reject(new Error("not requested")),
      step() {
        seen.push("background");
        return Promise.resolve(undefined);
      },
      close() {},
    });
    scheduler.enqueue(
      { provider: "test-v1", sessionID: "other", updated: 1 },
      "background",
    );
    const port = {
      scope: scheduler.setScope.bind(scheduler),
      release: scheduler.release.bind(scheduler),
      progress: () => [],
      observeProgress: () => () => {},
    };
    const app = await coreBackendFixture(await fixture(), {}, "tstv1-core", {
      sources: [digestProgressSource(port)],
    });
    const client = new WsClient(app.url);
    client.autoAcceptPages = false;
    const selected = outcome === "empty" ? undefined : app.session.id;
    try {
      // Opening a transport alone must not wake optional work before its hello.
      assertEquals(await scheduler.tick(), false);
      client.lease({ selected, crumbs: [], rows: [] });
      await client.connect();
      await client.rpc("prefs.get", {});
      if (outcome === "empty") {
        while (await scheduler.tick()) { /* immediate admission */ }
      } else {
        assertEquals(await scheduler.tick(), false);
        assertEquals(seen, []);
        const essential = scheduler.execute(
          () => {
            seen.push("essential");
            return Promise.resolve();
          },
          new AbortController().signal,
          "interactive",
        );
        await scheduler.tick();
        await essential;
        const attention = scheduler.execute(
          () => {
            seen.push("attention");
            return Promise.resolve();
          },
          new AbortController().signal,
          "attention",
        );
        await scheduler.tick();
        await attention;
        assertEquals(seen, ["essential", "attention"]);
        if (outcome === "failed") {
          app.app.backend.core.listMessages = () =>
            Promise.reject(new Error("native unavailable"));
          await assertRejects(() =>
            client.rpc("session.messages", { sessionID: selected })
          );
        } else if (outcome === "superseded") {
          client.lease({ crumbs: [], rows: [] });
        } else if (outcome === "cancelled") {
          app.app.backend.core.listMessages = (_id, _options, signal) =>
            new Promise((_resolve, reject) => {
              signal!.addEventListener("abort", () => reject(signal!.reason), {
                once: true,
              });
            });
          // The request owner's cancellation path releases the captured barrier.
          const window = (client.frames.find((f) =>
            f.t === "welcome"
          ) as Extract<typeof client.frames[number], { t: "welcome" }>).requests
            .window.id;
          const ref = {
            id: crypto.randomUUID(),
            key: crypto.randomUUID(),
            clientID: crypto.randomUUID(),
            window,
          };
          client.send({
            t: "request",
            ref,
            method: "session.messages",
            params: { sessionID: selected },
          });
          await client.wait((f) =>
            f.t === "request.accepted" && f.ref.key === ref.key
          );
          client.send({ t: "request.release", refs: [ref] });
        } else {
          await client.rpc("session.messages", { sessionID: selected });
          assertEquals(
            await scheduler.tick(),
            false,
            "response receipt is not consumer acceptance",
          );
          client.acceptPage(selected!);
        }
        await client.rpc("prefs.get", {});
        while (await scheduler.tick()) { /* release after settlement */ }
      }
      assertEquals(seen.at(-1), "background");
    } finally {
      await client.close();
      await app.app.stop();
    }
  });
}
