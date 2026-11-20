// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import {
  assertReadDemand,
  requestReads,
} from "../../fixtures/request-evidence.ts";
import type { ScaleFrame } from "../../fixtures/scale-wire.ts";

test(
  "transport.request-evidence-distinguishes-cancellation-window-and-duplicate-completion",
  {
    tag: ["@transport", "@contracts"],
  },
  () => {
    const events: ScaleFrame[] = [];
    const ref = (key: string, window = "one") => ({ key, window });
    const request = (key: string, window = "one") =>
      events.push({
        socket: 1,
        at: events.length,
        direction: "sent",
        frame: {
          t: "request",
          method: "permission.list",
          ref: ref(key, window),
          params: { sessionID: "blocked" },
        },
      });
    const result = (key: string, window = "one") =>
      events.push({
        socket: 1,
        at: events.length,
        direction: "received",
        frame: {
          t: "request.result",
          method: "",
          ref: ref(key, window),
          outcome: { ok: true },
        },
      });
    request("cancelled");
    events.push({
      socket: 1,
      at: events.length,
      direction: "sent",
      frame: { t: "request.release", method: "", refs: [ref("cancelled")] },
    });
    result("cancelled");
    request("completed");
    result("completed");
    request("new-window", "two");
    result("new-window", "two");
    const read = () =>
      requestReads(
        events,
        [{ name: "reload", start: 0, end: events.length }],
        "permission.list",
        new Set(["blocked"]),
      );
    expect(read().map((read) => read.status)).toEqual([
      "cancelled",
      "completed",
      "completed",
    ]);
    assertReadDemand(read(), "reload", ["blocked"]);
    // Deliberately broken fixture: two completed reads in the same window/scope.
    request("duplicate");
    result("duplicate");
    expect(() => assertReadDemand(read(), "reload", ["blocked"])).toThrow();
  },
);
