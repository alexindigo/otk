// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { derivePart, mapPart } from "../map.ts";
import { reachable } from "./source-support.ts";

Deno.test("native bookkeeping declares folded categories without losing source", () => {
  for (
    const [type, category, kind] of [
      ["step-start", "stepMarkers", "step-marker"],
      ["step-finish", "stepMarkers", "step-marker"],
      ["snapshot", "snapshots", "snapshot"],
    ]
  ) {
    const raw = {
      id: type,
      type,
      messageID: "m",
      sessionID: "s",
      snapshot: "sha",
      reason: "stop",
    };
    const part = mapPart(raw);
    assert(part.kind === "external");
    assertEquals(part.activity?.category, category);
    assertEquals(part.activity?.fold, true);
    assertEquals(part.activity?.summary?.kind, kind);
    assert(
      reachable(part, derivePart(raw), { origin: "message", id: "m" }).preview
        .includes(type),
    );
  }
  for (
    const type of ["patch", "retry", "subtask", "compaction", "future-record"]
  ) {
    const part = mapPart({ id: type, type, messageID: "m", sessionID: "s" });
    assert(part.kind === "external");
    assertEquals(part.activity?.fold, undefined);
  }
});
