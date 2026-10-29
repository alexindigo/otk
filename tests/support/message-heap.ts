// SPDX-License-Identifier: LGPL-3.0-only
import { assert } from "@std/assert";
import type { Cdp } from "./cdp.ts";
import { waitFor } from "./opencode.ts";

type Json = Record<string, unknown>;
interface Event {
  method: string;
  params: Json;
}
export interface HeapPort {
  send(method: string, params?: Json): Promise<Json>;
  events: Event[];
}
export interface MessageHeapSnapshot {
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

/** Public CDP Target session routing; no access to Cdp's transport internals.
 * Target.pdl parent auto-attachment and flat sessionId command routing.
 * https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Target.pdl */
export async function workerHeapPort(
  browser: Cdp,
  targetId: string,
): Promise<HeapPort & { close(): Promise<void> }> {
  await browser.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: "worker" }, { exclude: true }],
  });
  const attached = await waitFor(
    () =>
      browser.events.find((event) =>
        event.method === "Target.attachedToTarget" &&
        (event.params.targetInfo as { targetId: string }).targetId === targetId
      ),
    Boolean,
  );
  const sessionId = attached!.params.sessionId;
  assert(typeof sessionId === "string");
  await browser.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  await browser.send("Runtime.enable", {}, sessionId);
  const events: Event[] = [];
  let cursor = browser.events.length;
  const drain = () => {
    while (cursor < browser.events.length) {
      const event = browser.events[cursor++];
      if (
        event.sessionId !== sessionId
      ) continue;
      events.push({ method: event.method, params: event.params });
      // Snapshot payloads are retained by the feature's capture, not twice in
      // the root transport's diagnostic ledger over ten independent cycles.
      if (event.method === "HeapProfiler.addHeapSnapshotChunk") {
        event.params = {};
      }
    }
  };
  return {
    events,
    async send(method, params = {}) {
      const result = await browser.send(method, params, sessionId);
      drain();
      return result;
    },
    async close() {
      await browser.send("Target.detachFromTarget", { sessionId });
    },
  };
}

export async function captureMessageHeap(
  port: HeapPort,
  path: string,
): Promise<MessageHeapSnapshot> {
  await port.send("HeapProfiler.enable");
  await port.send("HeapProfiler.collectGarbage");
  const start = port.events.length;
  await port.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  const captured = port.events.splice(start);
  const chunks = captured.filter((e) =>
    e.method === "HeapProfiler.addHeapSnapshotChunk"
  );
  port.events.push(
    ...captured.filter((e) => e.method !== "HeapProfiler.addHeapSnapshotChunk"),
  );
  const source = chunks.map((e) => e.params.chunk).join("");
  assert(source.length > 0, "No heap snapshot chunks received");
  await Deno.writeTextFile(path, source);
  return JSON.parse(source);
}

/** Cooper/Harvey/Kennedy immediate dominators over the strongly reachable graph.
 * Retained sizes sum the dominator tree, not RSS, substring lengths or descendants
 * reachable through shared prototypes. Weak edges never establish retention. */
export function messageHeapRetention(
  heap: MessageHeapSnapshot,
  sessionID: string,
  marker: string,
) {
  const nf = heap.snapshot.meta.node_fields,
    ef = heap.snapshot.meta.edge_fields;
  const ns = nf.length, es = ef.length, count = heap.nodes.length / ns;
  const nodeField = (index: number, field: string) =>
    heap.nodes[index * ns + nf.indexOf(field)];
  const types = heap.snapshot.meta.node_types[0] as string[];
  const edgeTypes = heap.snapshot.meta.edge_types[0] as string[];
  const edgeType = (edge: number) =>
    edgeTypes[heap.edges[edge + ef.indexOf("type")]];
  const target = (edge: number) =>
    heap.edges[edge + ef.indexOf("to_node")] / ns;
  const name = (index: number) => heap.strings[nodeField(index, "name")];
  const type = (index: number) => types[nodeField(index, "type")];
  const starts = new Uint32Array(count + 1),
    incomingCount = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    starts[i + 1] = starts[i] + nodeField(i, "edge_count") * es;
  }
  for (let edge = 0; edge < heap.edges.length; edge += es) {
    if (edgeType(edge) !== "weak") incomingCount[target(edge)]++;
  }
  const incomingStart = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) {
    incomingStart[i + 1] = incomingStart[i] + incomingCount[i];
  }
  const incoming = new Uint32Array(incomingStart[count]),
    at = incomingStart.slice();
  for (let i = 0; i < count; i++) {
    for (let edge = starts[i]; edge < starts[i + 1]; edge += es) {
      if (edgeType(edge) !== "weak") {
        incoming[at[target(edge)]++] = i;
      }
    }
  }
  const seen = new Uint8Array(count), postorder: number[] = [];
  const stack = [0], next = [starts[0]];
  seen[0] = 1;
  while (stack.length) {
    const last = stack.length - 1, node = stack[last];
    let edge = next[last];
    while (
      edge < starts[node + 1] &&
      (edgeType(edge) === "weak" || seen[target(edge)])
    ) edge += es;
    if (edge === starts[node + 1]) {
      postorder.push(node);
      stack.pop();
      next.pop();
      continue;
    }
    next[last] = edge + es;
    const child = target(edge);
    seen[child] = 1;
    stack.push(child);
    next.push(starts[child]);
  }
  const order = new Int32Array(count).fill(-1);
  postorder.forEach((node, i) => order[node] = i);
  const dominator = new Int32Array(count).fill(-1);
  dominator[0] = 0;
  const intersect = (a: number, b: number) => {
    while (a !== b) {
      while (order[a] < order[b]) a = dominator[a];
      while (order[b] < order[a]) b = dominator[b];
    }
    return a;
  };
  let changed = true, passes = 0;
  while (changed) {
    changed = false;
    passes++;
    for (let i = postorder.length - 2; i >= 0; i--) {
      const node = postorder[i];
      let parent = -1;
      for (let p = incomingStart[node]; p < incomingStart[node + 1]; p++) {
        const from = incoming[p];
        if (dominator[from] !== -1) {
          parent = parent === -1 ? from : intersect(parent, from);
        }
      }
      if (parent !== dominator[node]) {
        dominator[node] = parent;
        changed = true;
      }
    }
  }
  const retained = new Float64Array(count);
  for (const node of postorder) retained[node] = nodeField(node, "self_size");
  for (const node of postorder) {
    if (node !== 0) retained[dominator[node]] += retained[node];
  }
  const marked = new Set<number>(),
    records: number[] = [],
    strings: number[] = [];
  for (const node of postorder) {
    if (
      type(node).endsWith("string") && name(node).length > 1024 &&
      name(node).includes(marker)
    ) {
      strings.push(node);
      marked.add(node);
    }
    if (type(node) !== "object") continue;
    let session = false, parts = false;
    for (let edge = starts[node]; edge < starts[node + 1]; edge += es) {
      if (edgeType(edge) !== "property") continue;
      const label =
        heap.strings[heap.edges[edge + ef.indexOf("name_or_index")]];
      if (label === "sessionID" && name(target(edge)) === sessionID) {
        session = true;
      }
      if (label === "parts") parts = true;
    }
    if (session && parts) {
      records.push(node);
      marked.add(node);
    }
  }
  let bytes = 0;
  const roots: { id: number; retainedBytes: number; dominators: string[] }[] =
    [];
  for (const node of marked) {
    let parent = dominator[node], nested = false;
    const path: string[] = [];
    while (parent !== node && parent !== 0) {
      if (marked.has(parent)) {
        nested = true;
        break;
      }
      path.push(
        `${type(parent)} ${name(parent).slice(0, 60)}#${
          nodeField(parent, "id")
        }`,
      );
      parent = dominator[parent];
    }
    if (nested) continue;
    bytes += retained[node];
    roots.push({
      id: nodeField(node, "id"),
      retainedBytes: retained[node],
      dominators: path,
    });
  }
  return {
    retainedBytes: bytes,
    messageRecords: records.length,
    sourceStrings: strings.length,
    reachable: postorder.length,
    passes,
    roots,
  };
}
