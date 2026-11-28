// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import {
  assertReadDemand,
  requestReads,
} from "../../fixtures/request-evidence.ts";
import type { ScaleFrame } from "../../fixtures/scale-wire.ts";

test("harness.read-demand-requires-live-socket-settlement", {
  tag: ["@harness", "@scale"],
}, () => {
  const request: ScaleFrame = {
    socket: 1,
    direction: "sent",
    at: 0,
    frame: {
      t: "request",
      method: "permission.list",
      ref: { key: "read", window: "window" },
      params: { sessionID: "blocked" },
    },
  };
  const close: ScaleFrame = {
    socket: 1,
    direction: "received",
    at: 1,
    frame: { t: "socket.closed", method: "" },
  };
  const result: ScaleFrame = {
    ...close,
    frame: {
      t: "request.result",
      method: "",
      ref: request.frame.ref,
      outcome: { ok: true },
    },
  };
  const reads = (frames: ScaleFrame[]) =>
    requestReads(
      frames,
      [{ name: "reload", start: 0, end: frames.length }],
      "permission.list",
      new Set(["blocked"]),
    );
  expect(reads([request])[0].status).toBe("pending");
  expect(() => assertReadDemand(reads([request]), "reload")).toThrow();
  expect(reads([request, close])[0].status).toBe("cancelled");
  assertReadDemand(reads([request, close]), "reload");
  expect(() => assertReadDemand(reads([request, close]), "reload", ["blocked"]))
    .toThrow();
  expect(reads([request, { ...close, socket: 2 }])[0].status).toBe("pending");
  expect(reads([request, close, result])[0].status).toBe("cancelled");
  assertReadDemand(reads([request, result, close]), "reload", ["blocked"]);
  expect(() =>
    assertReadDemand(reads([request, result, request, result]), "reload")
  )
    .toThrow();
  expect(() =>
    assertReadDemand(
      reads([
        request,
        { ...result, frame: { ...result.frame, outcome: { ok: false } } },
        close,
      ]),
      "reload",
    )
  ).toThrow();
});
