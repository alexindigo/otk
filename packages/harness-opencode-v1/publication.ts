// SPDX-License-Identifier: LGPL-3.0-only
import type { HarnessSink } from "@otk/harness";

/** Async work captures this connection's port, never a replacement's sink. */
export function connectionPublication(
  sink: HarnessSink,
  signal: AbortSignal,
): HarnessSink {
  return {
    index: sink.index,
    retainedSessions: sink.retainedSessions,
    error: (value) => {
      if (!signal.aborted) sink.error?.(value);
    },
    projectSeeds: (values) => {
      if (!signal.aborted) sink.projectSeeds?.(values);
    },
    projectMetadata: (project, source) =>
      !signal.aborted && (sink.projectMetadata?.(project, source) ?? false),
    projectAuthority: (activity) => {
      if (!signal.aborted) sink.projectAuthority?.(activity);
    },
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
    content: (id, event, clock) => {
      if (!signal.aborted) sink.content(id, event, clock);
    },
    bootstrapComplete: () => {
      if (!signal.aborted) sink.bootstrapComplete();
    },
    invalidate: (value) => {
      if (!signal.aborted) sink.invalidate(value);
    },
  };
}
