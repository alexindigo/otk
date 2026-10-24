// SPDX-License-Identifier: LGPL-3.0-only
import type { HarnessSink } from "@otk/harness";

/** Async work captures this connection's port, never a replacement's sink. */
export function connectionPublication(
  sink: HarnessSink,
  signal: AbortSignal,
): HarnessSink {
  return {
    index: sink.index,
    connection: (state) => {
      if (!signal.aborted) sink.connection(state);
    },
    indexReset: (entries) => {
      if (!signal.aborted) sink.indexReset(entries);
    },
    indexUpsert: (entry) => {
      if (!signal.aborted) sink.indexUpsert(entry);
    },
    indexRemove: (id) => {
      if (!signal.aborted) sink.indexRemove(id);
    },
    content: (id, event) => {
      if (!signal.aborted) sink.content(id, event);
    },
    resync: (ids) => {
      if (!signal.aborted) sink.resync(ids);
    },
  };
}
