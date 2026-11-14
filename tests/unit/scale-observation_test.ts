// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { observation } from "../support/observation.ts";
import { request } from "../support/fixture-control.ts";

Deno.test("readiness polls return scalar counts without the full evidence export", () => {
  const calls: Record<string, number> = {};
  const ready = new Set(["a", "b"]);
  const field = (name: string, value: () => unknown) => () => {
    calls[name] = (calls[name] ?? 0) + 1;
    return value();
  };
  const fields = {
    ready: field("ready", () => [...ready]),
    readyCount: field("readyCount", () => ready.size),
    entries: field("entries", () => [{ id: "a", turns: { t: 1 } }]),
    frames: field("frames", () => [{ t: "harness" }]),
  };
  for (let poll = 0; poll < 100; poll++) {
    assertEquals(
      observation(fields, { fields: ["readyCount"] }, () => undefined, [
        "readyCount",
      ]),
      { readyCount: poll + 2 },
    );
    ready.add(`s${poll}`);
  }
  assertEquals(calls, { readyCount: 100 });
  assertEquals(
    observation(fields, { entry: "a" }, (id) => ({ id, status: "idle" })),
    { entry: { id: "a", status: "idle" } },
  );
  assertEquals(
    observation(fields, { entry: "x" }, () => undefined),
    { entry: null },
  );
  const full = observation(fields, undefined, () => undefined, ["readyCount"]);
  assertEquals(Object.keys(full), ["ready", "entries", "frames"]);
  assertEquals(calls, { readyCount: 100, ready: 1, entries: 1, frames: 1 });
  assertThrows(
    () => observation(fields, { fields: ["missing"] }, () => undefined),
    Error,
    "Unknown observation fields",
  );
});
Deno.test("observation selection is a bounded fixture protocol field", () => {
  const frame = (params: unknown) => ({
    v: 1,
    id: "1",
    command: "observe",
    params,
  });
  assertEquals(
    request(frame({ select: { fields: ["readyCount"], entry: "ses_1" } }))
      .params,
    { select: { fields: ["readyCount"], entry: "ses_1" } },
  );
  for (
    const select of [
      { fields: "readyCount" },
      { fields: ["ready-count"] },
      { fields: Array(33).fill("ready") },
      { entry: "" },
      { other: true },
    ]
  ) assertThrows(() => request(frame({ select })));
});
