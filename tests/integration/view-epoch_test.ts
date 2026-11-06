// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createIndex, SidecarConnection } from "@otk/client";
import type { ServerFrame } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { originFetch } from "../support/request-wire.ts";
import { waitFor } from "../support/opencode.ts";

test("a newer lease recovers an unchanged selected entry from a dropped older epoch", async () => {
  const app = await coreBackendFixture(await fixture());
  const index = createIndex();
  let socket: WebSocket | undefined, held: MessageEvent | undefined;
  let deliver: ((event: MessageEvent) => void) | undefined;
  let hold = false;
  const frames: ServerFrame[] = [];
  const connection = new SidecarConnection(app.url, {
    status() {},
    frame(frame) {
      frames.push(frame);
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        return index.receive("one", frame);
      }
    },
  }, {
    fetcher: originFetch(app.url),
    socket(address) {
      socket = Reflect.construct(WebSocket, [address, {
        headers: { Origin: app.url },
      }]);
      const raw = socket!;
      return new Proxy(raw, {
        set(target, key, value) {
          if (key === "onmessage" && value) {
            deliver = value;
            target.onmessage = (event) => {
              const frame = JSON.parse(event.data);
              if (hold && frame.t === "index.patch") held = event;
              else value(event);
            };
            return true;
          }
          return Reflect.set(target, key, value);
        },
        get(target, key) {
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  try {
    await connection.connect();
    await waitFor(() => frames.some((f) => f.t === "index.snapshot"), Boolean);
    hold = true;
    connection.view({ selected: "tstv1-core", crumbs: [], rows: [] });
    await waitFor(() => !!held, Boolean);
    connection.view({
      selected: "tstv1-core",
      crumbs: [],
      rows: ["tstv1-core"],
    });
    hold = false;
    deliver!(held!);
    assertEquals(index.get("one", "tstv1-core"), undefined);
    await waitFor(() => index.get("one", "tstv1-core"), Boolean);
    assert(index.get("one", "tstv1-core"));
    assertEquals(frames.filter((f) => f.t === "index.snapshot").length, 1);
    assert(frames.some((f) => f.t === "index.patch" && f.epoch === 2));
  } finally {
    const closed = socket &&
      new Promise<void>((resolve) =>
        socket!.addEventListener("close", () => resolve(), { once: true })
      );
    connection.stop();
    await closed;
    await app.app.stop();
  }
});
