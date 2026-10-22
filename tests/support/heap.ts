// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { Cdp } from "./cdp.ts";

interface Snapshot {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: (string[] | string)[];
      edge_fields: string[];
      edge_types: (string[] | string)[];
    };
  };
  nodes: number[];
  edges: number[];
  strings: string[];
}
export interface RetainedContent {
  id: number;
  name: string;
  properties: string[];
  incoming: string[];
}

/** Inspect content identities, never use whole-isolate allocation as a leak proxy. */
export async function sessionHeap(
  browser: Cdp,
  sessionID: string,
  marker: string,
): Promise<RetainedContent[]> {
  await browser.send("HeapProfiler.enable");
  await browser.send("HeapProfiler.collectGarbage");
  const start = browser.events.length;
  await browser.send("HeapProfiler.takeHeapSnapshot", {
    reportProgress: false,
  });
  const captured = browser.events.splice(start);
  const chunks = captured.filter((event) =>
    event.method === "HeapProfiler.addHeapSnapshotChunk"
  );
  browser.events.push(
    ...captured.filter((event) =>
      event.method !== "HeapProfiler.addHeapSnapshotChunk"
    ),
  );
  const heap: Snapshot = JSON.parse(
    chunks.map((event) => event.params.chunk).join(""),
  );
  const nf = heap.snapshot.meta.node_fields,
    ef = heap.snapshot.meta.edge_fields;
  const ns = nf.length, es = ef.length;
  const field = (node: number, name: string) =>
    heap.nodes[node + nf.indexOf(name)];
  const string = (node: number) => heap.strings[field(node, "name")];
  const nodeTypes = heap.snapshot.meta.node_types[0] as string[];
  const edgeTypes = heap.snapshot.meta.edge_types[0] as string[];
  const found = new Map<number, RetainedContent>();
  let edge = 0;
  for (let node = 0; node < heap.nodes.length; node += ns) {
    const properties = new Map<string, number>();
    const end = edge + field(node, "edge_count") * es;
    for (; edge < end; edge += es) {
      if (edgeTypes[heap.edges[edge + ef.indexOf("type")]] !== "property") {
        continue;
      }
      properties.set(
        heap.strings[heap.edges[edge + ef.indexOf("name_or_index")]],
        heap.edges[edge + ef.indexOf("to_node")],
      );
    }
    if (nodeTypes[field(node, "type")] !== "object") continue;
    const content = [...properties].some(([key, target]) =>
      ["text", "source"].includes(key) && string(target).startsWith(marker)
    );
    const message = properties.has("parts") && properties.has("sessionID") &&
      string(properties.get("sessionID")!) === sessionID;
    if (content || message) {
      found.set(node, {
        id: field(node, "id"),
        name: string(node),
        properties: [...properties.keys()],
        incoming: [],
      });
    }
  }
  // Failure diagnostics identify the immediate retaining owners without keeping
  // remote handles (which themselves would prevent collection).
  edge = 0;
  for (let node = 0; node < heap.nodes.length; node += ns) {
    const end = edge + field(node, "edge_count") * es;
    for (; edge < end; edge += es) {
      const retained = found.get(heap.edges[edge + ef.indexOf("to_node")]);
      if (!retained || retained.incoming.length >= 8) continue;
      const type = edgeTypes[heap.edges[edge + ef.indexOf("type")]];
      const key = heap.edges[edge + ef.indexOf("name_or_index")];
      retained.incoming.push(
        `${string(node)}#${field(node, "id")}.${
          type === "element" ? key : heap.strings[key]
        }`,
      );
    }
  }
  return [...found.values()];
}

export function assertContentLoaded(objects: RetainedContent[]): void {
  assert(
    objects.length > 0,
    "Heap snapshot did not identify loaded session content",
  );
}
export function assertContentReleased(objects: RetainedContent[]): void {
  assertEquals(
    objects,
    [],
    "Disposed session content remains reachable in the browser heap",
  );
}
