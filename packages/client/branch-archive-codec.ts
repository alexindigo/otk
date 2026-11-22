// SPDX-License-Identifier: LGPL-3.0-only
/** Browser archive representation. Content strings and repeated structures have
 * one node, including content shared by native Source, prompts and draft chips.
 * JSON Source previews are stored as structure and rendered only on inspection. */
type Node = string | number | boolean | null | { array: number[] } | {
  object: [string, number][];
} | { source: number };
export interface BranchArchive {
  schema: 2;
  nodes: Node[];
  root: number;
}
export function packBranch(value: unknown): BranchArchive {
  const nodes: Node[] = [], known = new Map<string, number>();
  const intern = (node: Node): number => {
    const key = JSON.stringify(node), found = known.get(key);
    if (found !== undefined) return found;
    const id = nodes.length;
    nodes.push(node);
    known.set(key, id);
    return id;
  };
  const visit = (value: unknown, source = false, native = false): number => {
    if (value === null || typeof value !== "object") {
      return intern(value as string | number | boolean | null);
    }
    if (Array.isArray(value)) {
      return intern({ array: value.map((v) => visit(v, false, native)) });
    }
    return intern({
      object: Object.entries(value).filter(([, v]) => v !== undefined).map(
        ([k, v]): [string, number] => {
          if (!native && source && k === "preview" && typeof v === "string") {
            try {
              return [k, intern({ source: visit(JSON.parse(v), false, true) })];
            } catch {
              /* A truncated or plain-text Source is already canonical. */
            }
          }
          return [k, visit(v, k === "source", native)];
        },
      ),
    });
  };
  const root = visit(value);
  return { schema: 2, nodes, root };
}
export function unpackBranch(archive: BranchArchive): unknown {
  const visit = (id: number): unknown => {
    const node = archive.nodes[id];
    if (node === null || typeof node !== "object") return node;
    if ("array" in node) return node.array.map(visit);
    if ("source" in node) return JSON.stringify(visit(node.source), null, 2);
    const result: Record<string, unknown> = {};
    for (const [key, child] of node.object) {
      const value = archive.nodes[child];
      if (value && typeof value === "object" && "source" in value) {
        Object.defineProperty(result, key, {
          enumerable: true,
          configurable: true,
          get: () => visit(child),
        });
      } else {
        // Native JSON keys are data, including __proto__ in browser engines.
        Object.defineProperty(result, key, {
          enumerable: true,
          configurable: true,
          writable: true,
          value: visit(child),
        });
      }
    }
    return result;
  };
  return visit(archive.root);
}
