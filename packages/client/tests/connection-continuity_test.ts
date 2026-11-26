// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { PROTOCOL_VERSION } from "@otk/protocol";
import { ManualClock } from "../../../tests/support/manual-clock.ts";
import { fixtureMessagePolicy } from "../../../tests/support/message-pages.ts";
import {
  bootstrapFetch,
  fixtureRequestPolicy,
  fixtureRequests,
} from "../../../tests/support/request-wire.ts";
import { SidecarConnection } from "../connection.ts";
import { ReloadRefused } from "../reload.ts";
import type { ServerContinuity } from "../server-continuity.ts";

Deno.test("one grace timer across refused socket attempts, with welcome and Reload owned by the connection", async () => {
  for (const local of [true, false]) {
    const clock = new ManualClock();
    using _timers = clock.install();
    const states: ServerContinuity[] = [];
    let socket: {
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      readyState: number;
      close(): void;
      send(): void;
    };
    const connection = new SidecarConnection("http://example.test", {
      status() {},
      continuity: (value) => states.push(value),
      frame() {},
    }, {
      page: local ? { build: "a" } : undefined,
      policy: fixtureRequestPolicy,
      fetcher: bootstrapFetch(),
      socket() {
        socket = { close() {}, send() {}, readyState: WebSocket.OPEN };
        return socket as unknown as WebSocket;
      },
      reload: () =>
        Promise.reject(
          new ReloadRefused("Still unreachable. Page not reloaded."),
        ),
    });
    const welcome = (build: string) =>
      socket.onmessage!({
        data: JSON.stringify({
          t: "welcome",
          protocol: PROTOCOL_VERSION,
          messages: fixtureMessagePolicy,
          requests: fixtureRequests(),
          sidecar: {
            build,
            instance: build,
            version: "test",
            harness: { kind: "test", version: "test", url: "" },
          },
        }),
      });
    const refusal = () => {
      const latest = states.at(-1);
      return latest?.kind !== "live" ? latest?.refused : undefined;
    };
    try {
      await connection.connect();
      welcome("a");
      socket!.onclose!();
      for (let i = 0; i < 3; i++) {
        await connection.connect();
        socket!.onclose!();
      }
      clock.advanceTo(9999);
      assertEquals(states.map(({ kind }) => kind), ["away", "live", "away"]);
      clock.advanceTo(10_000);
      assertEquals(states.map(({ kind }) => kind), [
        "away",
        "live",
        "away",
        "unreachable",
      ]);
      await connection.reload();
      assertEquals(refusal(), "Still unreachable. Page not reloaded.");
      const retry = connection.reload();
      assertEquals(refusal(), undefined);
      await retry;
      await connection.connect();
      welcome("b");
      assertEquals(
        states.at(-1),
        local
          ? { kind: "updated", build: "b" }
          : { kind: "live", restarted: { instance: "b", updated: true } },
      );
    } finally {
      connection.stop();
    }
  }
});
