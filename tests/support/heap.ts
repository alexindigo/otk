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
  kind: "object" | "string" | "dom";
  type: string;
  properties: string[];
  incoming: string[];
  path: string[];
}
interface DomNode {
  backendNodeId: number;
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
  children?: DomNode[];
}

/** One fixed GC sample, covering content independently of its retaining owner. */
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
  const type = (node: number) => nodeTypes[field(node, "type")];
  const edgeType = (edge: number) =>
    edgeTypes[heap.edges[edge + ef.indexOf("type")]];
  const target = (edge: number) => heap.edges[edge + ef.indexOf("to_node")];
  const label = (edge: number) => {
    const key = heap.edges[edge + ef.indexOf("name_or_index")];
    return `${edgeType(edge)}:${
      ["element", "hidden"].includes(edgeType(edge)) ? key : heap.strings[key]
    }`;
  };
  const count = heap.nodes.length / ns;
  const starts = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) {
    starts[i + 1] = starts[i] + field(i * ns, "edge_count") * es;
  }
  // Presence in the strings table or a weak edge is not strong reachability.
  const parents = new Int32Array(count).fill(-1);
  const parentEdges = new Int32Array(count).fill(-1);
  const queue = [0];
  parents[0] = 0;
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (let e = starts[node]; e < starts[node + 1]; e += es) {
      if (edgeType(e) === "weak") continue;
      const to = target(e) / ns;
      if (parents[to] !== -1) continue;
      parents[to] = node;
      parentEdges[to] = e;
      queue.push(to);
    }
  }
  const describe = (node: number) =>
    `${type(node)} ${string(node).slice(0, 100)}#${field(node, "id")}`;
  const found = new Map<number, RetainedContent>();
  const add = (
    node: number,
    kind: RetainedContent["kind"],
    properties: string[] = [],
  ) => {
    const path: string[] = [];
    for (let i = node / ns; i !== 0; i = parents[i]) {
      assert(i >= 0, "Retained content has no strong root path");
      path.push(`${describe(parents[i] * ns)} --${label(parentEdges[i])}-->`);
    }
    found.set(node, {
      id: field(node, "id"),
      name: string(node).slice(0, 100),
      kind,
      type: type(node),
      properties,
      incoming: [],
      path: [...path.reverse(), describe(node)],
    });
  };
  // Primitive strings cannot be resolved with getObjectByHeapObjectId. Their
  // contents belong to snapshot names; cons nodes additionally have first/second
  // string edges. Summaries detect markers across rope boundaries without
  // expanding huge ropes, and an explicit stack handles deeply nested strings.
  assert(marker.length > 0, "A session-content marker is required");
  interface Summary {
    prefix: string;
    suffix: string;
    matches: boolean;
  }
  const summaries = new Map<number, Summary>();
  const children = (node: number): number[] => {
    if (type(node) !== "concatenated string") return [];
    const parts = new Map<string, number>();
    for (let e = starts[node / ns]; e < starts[node / ns + 1]; e += es) {
      parts.set(label(e), target(e));
    }
    const first = parts.get("internal:first"),
      second = parts.get("internal:second");
    assert(
      first !== undefined && second !== undefined,
      `Missing cons edges: ${describe(node)}`,
    );
    return [first, second];
  };
  const width = marker.length - 1;
  const summarize = (value: string): Summary => ({
    prefix: value.slice(0, width),
    suffix: width ? value.slice(-width) : "",
    matches: value.includes(marker),
  });
  const matchingStrings = new Set<number>();
  for (const index of queue) {
    const node = index * ns;
    if (!type(node).endsWith("string")) continue;
    const stack: [number, boolean][] = [[node, false]];
    while (stack.length) {
      const [current, ready] = stack.pop()!;
      if (summaries.has(current)) continue;
      const parts = children(current);
      if (parts.length && !ready) {
        stack.push(
          [current, true],
          ...parts.map((part): [number, boolean] => [part, false]),
        );
        continue;
      }
      let summary = summarize(string(current));
      if (parts.length) {
        const [left, right] = parts.map((part) => summaries.get(part)!);
        summary = {
          prefix: (left.prefix + right.prefix).slice(0, width),
          suffix: width ? (left.suffix + right.suffix).slice(-width) : "",
          matches: left.matches || right.matches ||
            (left.suffix + right.prefix).includes(marker),
        };
      }
      summaries.set(current, summary);
    }
    // A sliced string retains its parent through a strong edge, so matching
    // backing storage is independently visited even if the slice excludes it.
    if (!summaries.get(node)!.matches) continue;
    matchingStrings.add(node);
    add(node, "string");
  }
  const group = "otk-session-heap-inspection";
  await browser.send("DOM.enable");
  try {
    for (const index of queue) {
      const node = index * ns;
      if (type(node) !== "object") continue;
      const properties = new Map<string, number>();
      for (let e = starts[index]; e < starts[index + 1]; e += es) {
        if (edgeType(e) !== "property") continue;
        properties.set(
          heap.strings[heap.edges[e + ef.indexOf("name_or_index")]],
          target(e),
        );
      }
      const content = ["text", "source"].some((key) =>
        matchingStrings.has(properties.get(key)!)
      );
      const message = properties.has("parts") && properties.has("sessionID") &&
        string(properties.get("sessionID")!) === sessionID;
      if (content || message) add(node, "object", [...properties.keys()]);
    }
    // Blink Text can own a payload with no V8 string. Check detached native
    // transcript trees too, including descendants of an empty transcript root.
    const { detachedNodes } = await browser.send(
      "DOM.getDetachedDomNodes",
    ) as unknown as {
      detachedNodes: { treeNode: DomNode }[];
    };
    for (const { treeNode } of detachedNodes) {
      const nodes: DomNode[] = [];
      const visit = (node: DomNode) => {
        nodes.push(node);
        node.children?.forEach(visit);
      };
      visit(treeNode);
      if (
        !nodes.some((node) =>
          node.nodeValue.includes(marker) ||
          node.attributes?.some((value, i, attrs) =>
            i % 2 === 1 && attrs[i - 1] === "class" &&
            value.split(/\s+/).some((name) =>
              ["otk-messages", "otk-message"].includes(name)
            )
          )
        )
      ) continue;
      for (const node of nodes) {
        const { object } = await browser.send("DOM.resolveNode", {
          backendNodeId: node.backendNodeId,
          objectGroup: group,
        }) as { object: { objectId: string } };
        const { heapSnapshotObjectId } = await browser.send(
          "HeapProfiler.getHeapObjectId",
          {
            objectId: object.objectId,
          },
        );
        const index = queue.find((i) =>
          field(i * ns, "id") === Number(heapSnapshotObjectId)
        );
        assert(
          index !== undefined,
          `Detached ${node.nodeName}#${node.backendNodeId} lacks a sampled strong retaining path`,
        );
        add(index * ns, "dom");
      }
    }
  } finally {
    // Transient inspection handles and DOM mirrors cannot retain a later sample.
    try {
      await browser.send("Runtime.releaseObjectGroup", { objectGroup: group });
    } finally {
      await browser.send("DOM.disable");
    }
  }
  for (const index of queue) {
    for (let e = starts[index]; e < starts[index + 1]; e += es) {
      if (edgeType(e) === "weak") continue;
      const retained = found.get(target(e));
      if (!retained || retained.incoming.length >= 8) continue;
      retained.incoming.push(`${describe(index * ns)} --${label(e)}-->`);
    }
  }
  return [...found.values()];
}

export function assertContentLoaded(objects: RetainedContent[]): void {
  for (const kind of ["object", "string"]) {
    assert(
      objects.some((object) => object.kind === kind),
      `Heap snapshot did not identify loaded session content ${kind}s`,
    );
  }
}
export function assertContentReleased(objects: RetainedContent[]): void {
  assertEquals(
    objects,
    [],
    "Disposed session content remains reachable in the browser heap",
  );
}
