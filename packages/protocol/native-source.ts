// SPDX-License-Identifier: LGPL-3.0-only
import type {
  Message,
  NativeSource,
  NativeSourceView,
  Part,
  ToolCall,
} from "./content.ts";
import type { RequestMetadata } from "./request-metadata.ts";

export const sourceRequestMetadata: Readonly<Record<string, RequestMetadata>> =
  {
    "source.get": { kind: "read", pending: "Loading source" },
  };
export interface SourceRpcMethods {
  "source.get": {
    params: { sessionID: string; ref: string };
    result: NativeSourceView;
  };
}
type Holder = { source?: NativeSource };
/** Structural locations of every source in one item; plugins own the meaning. */
function* holders(
  value: Message | Part,
): Generator<{ path: string; holder: Holder; part?: Part }> {
  const calls = function* (call: ToolCall, path: string): Generator<{
    path: string;
    holder: Holder;
  }> {
    yield { path, holder: call };
    for (const child of call.children ?? []) {
      yield* calls(child, `${path}/${child.callID}`);
    }
  };
  const parts = function* (part: Part) {
    const path = `p:${part.id}`;
    yield { path, holder: part as Holder, part };
    if (part.kind === "tool") yield* calls(part.call, `${path}/c`);
  };
  if ("role" in value) {
    yield { path: "", holder: value };
    for (const part of value.parts) yield* parts(part);
  } else yield* parts(value);
}
/** Loaded items carry references only; exact text stays for declared content. */
export function referenceSources<T extends Message | Part>(
  value: T,
  ref: (path: string) => string,
): T {
  for (const { path, holder, part } of holders(value)) {
    const source = holder.source;
    if (!source) continue;
    if (source.ref !== undefined) {
      if (part?.kind === "external") delete part.data;
      continue;
    }
    holder.source = {
      kind: source.kind,
      ref: ref(path),
      ...(source.revision !== undefined ? { revision: source.revision } : {}),
      ...(part?.kind === "external" && part.content &&
          source.payload !== undefined
        ? { payload: source.payload }
        : {}),
    };
    if (part?.kind === "external") delete part.data;
  }
  return value;
}
/** Opaque references and their structural owners, without plugin decoding. */
export function* sourceEntries(value: Message | Part): Generator<{
  ref: string;
  path: string;
  owner: object;
  revision?: string;
}> {
  for (const { holder, path } of holders(value)) {
    if (holder.source?.ref) {
      yield {
        ref: holder.source.ref,
        path,
        owner: holder,
        revision: holder.source.revision,
      };
    }
  }
}
/** The derived source at one structural location, as a bounded view. */
export function sourceAt(
  value: Message | Part,
  path: string,
): NativeSourceView | undefined {
  for (const entry of holders(value)) {
    const source = entry.holder.source;
    if (entry.path !== path || !source || source.preview === undefined) {
      continue;
    }
    return {
      kind: source.kind,
      preview: source.preview,
      bytes: source.bytes ?? new TextEncoder().encode(source.preview).length,
      truncated: !!source.truncated,
    };
  }
}
