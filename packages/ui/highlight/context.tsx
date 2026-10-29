// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, useContext } from "solid-js";
import type { TranscriptOwner } from "@otk/client";
import { createHighlightLease, type HighlightLease } from "./client.ts";
const Context = createContext<HighlightLease | null>(null);
const leases = new WeakMap<TranscriptOwner, HighlightLease>();
/** The body owner ends the lease on cold/removal, even after its view unmounts. */
export function transcriptHighlightLease(
  resource: TranscriptOwner,
): HighlightLease {
  const current = leases.get(resource);
  if (current?.live) return current;
  const lease = createHighlightLease();
  leases.set(resource, lease);
  const release = resource.subscribe((state) => {
    if (state.temperature !== "cold") return;
    release();
    lease.dispose();
    leases.delete(resource);
  });
  return lease;
}
export function HighlightProvider(
  props: { lease?: HighlightLease; children: Element },
): Element {
  return <Context value={props.lease ?? null}>{props.children}</Context>;
}
export const useHighlightLease = () => useContext(Context) ?? undefined;
