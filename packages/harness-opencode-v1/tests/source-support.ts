// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  type Message,
  type NativeSourceView,
  type Part,
  sourceAt,
} from "@otk/protocol";
import { parseSourceRef } from "../records.ts";

/** A loaded item carries only its reference; the Source read derives it exactly. */
export function reachable(
  loaded: Message | Part,
  derived: Message | Part,
  expected: { origin: "message" | "record"; id: string },
): NativeSourceView {
  const source = "source" in loaded ? loaded.source : undefined;
  assert(source?.ref, "Loaded item must keep a source reference");
  assertEquals(source.preview, undefined);
  const decoded = parseSourceRef(source.ref);
  assertEquals({ origin: decoded.origin, id: decoded.id }, expected);
  const view = sourceAt(derived, decoded.path);
  assert(view, "Referenced source must stay reachable");
  return view;
}
