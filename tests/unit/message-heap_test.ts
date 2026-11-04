// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  messageHeapRetention,
  type MessageHeapSnapshot,
} from "../support/message-heap-analysis.ts";

function snapshot(shared: boolean, remove: boolean): MessageHeapSnapshot {
  const strings = [
    "",
    "Object",
    "scope",
    "Array",
    "BODY_MARKER_" + "x".repeat(2048),
    "Prototype",
    "BODY_MARKER_" + "y".repeat(2048),
    "sessionID",
    "parts",
    "prototype",
    "source",
  ];
  const outgoing: [number, number, number][][] = [
    [...(remove ? [] : [[0, 0, 1] as [number, number, number]]), [0, 0, 5], [
      1,
      0,
      6,
    ], ...(shared ? [[0, 0, 4] as [number, number, number]] : [])],
    [[0, 7, 2], [0, 8, 3], [0, 9, 5]],
    [],
    [[0, 10, 4]],
    [],
    [[0, 9, 5]],
    [],
  ];
  const nodes = [
    [0, 0, 1, 0],
    [1, 1, 3, 24],
    [2, 2, 5, 12],
    [1, 3, 7, 24],
    [2, 4, 9, 4000],
    [1, 5, 11, 10000],
    [2, 6, 13, 8000],
  ];
  return {
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count"],
        node_types: [["synthetic", "object", "string"]],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [["property", "weak"]],
      },
    },
    nodes: nodes.flatMap((node, i) => [...node, outgoing[i].length]),
    edges: outgoing.flatMap((edges) =>
      edges.flatMap(([kind, name, target]) => [kind, name, target * 5])
    ),
    strings,
  };
}

Deno.test("heap dominators exclude shared prototypes, weak-only source and double-counted body descendants", () => {
  const value = messageHeapRetention(
    snapshot(false, false),
    "scope",
    "BODY_MARKER_",
  );
  assertEquals(value.retainedBytes, 4060);
  assertEquals(value.messageRecords, 1);
  assertEquals(value.sourceStrings, 1);
  assertEquals(value.roots.length, 1);
});
Deno.test("heap probe finds source retained outside its message after the canonical body is released", () => {
  const leaked = messageHeapRetention(
    snapshot(true, true),
    "scope",
    "BODY_MARKER_",
  );
  assertEquals(leaked.messageRecords, 0);
  assertEquals(leaked.sourceStrings, 1);
  assertEquals(leaked.retainedBytes, 4000);
  const released = messageHeapRetention(
    snapshot(false, true),
    "scope",
    "BODY_MARKER_",
  );
  assertEquals(released.messageRecords, 0);
  assertEquals(released.retainedBytes, 0);
});
