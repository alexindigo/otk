// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestDelta, SessionMetadata, UsageSummary } from "@otk/protocol";
import {
  type DigestBookkeepingRecord,
  type DigestSessionRecord,
  DigestStore,
  type DigestTurnRecord,
  type DigestUsageRecord,
} from "@otk/store";
import type {
  DigestCheckpoint,
  DigestSnapshot,
} from "@otk/harness-opencode-v1";

export function usage(row: DigestUsageRecord): UsageSummary {
  return {
    calls: row.call_count ?? 0,
    cost: row.cost,
    tokens: {
      input: row.input,
      output: row.output,
      reasoning: row.reasoning,
      cache: { read: row.cache_read, write: row.cache_write },
    },
    contextPeak: row.context_peak,
    ...(row.time_start === null ? {} : {
      time: {
        start: row.time_start,
        ...(row.time_end === null ? {} : { end: row.time_end }),
      },
    }),
  };
}
function usageRecord(
  total: UsageSummary | undefined,
  revision: number,
): DigestUsageRecord {
  return {
    call_count: total?.calls ?? null,
    cost: total?.cost ?? null,
    input: total?.tokens.input ?? null,
    output: total?.tokens.output ?? null,
    reasoning: total?.tokens.reasoning ?? null,
    cache_read: total?.tokens.cache.read ?? null,
    cache_write: total?.tokens.cache.write ?? null,
    time_start: total?.time?.start ?? null,
    time_end: total?.time?.end ?? null,
    context_peak: total?.contextPeak ?? null,
    revision,
  };
}
export function snapshot(row: DigestSessionRecord): DigestSnapshot {
  return {
    metadata: {
      id: row.id,
      ...(row.parent_id === null ? {} : { parentID: row.parent_id }),
      directory: row.directory,
      projectID: row.project_id,
      title: row.title,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      archived: row.archived === 1,
      status: "idle",
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
    },
    summary: {
      state: row.state,
      revision: row.revision,
      ...(row.digested_at === null ? {} : { digestedAt: row.digested_at }),
      ...(row.native_updated_at === null
        ? {}
        : { nativeUpdatedAt: row.native_updated_at }),
      ...(row.message_count === null
        ? {}
        : { messageCount: row.message_count }),
      ...(row.call_count === null ? {} : { total: usage(row) }),
      ...(row.last_agent === null && row.last_model === null ? {} : {
        last: {
          ...(row.last_agent === null ? {} : { agent: row.last_agent }),
          ...(row.last_provider !== null && row.last_model !== null
            ? { model: { provider: row.last_provider, model: row.last_model } }
            : {}),
          context: {
            input: row.context_input,
            output: row.context_output,
            reasoning: row.context_reasoning,
            cache: {
              read: row.context_cache_read,
              write: row.context_cache_write,
            },
          },
        },
      }),
    },
    deleted: row.deleted_at !== null && row.deleted_how !== null
      ? { at: row.deleted_at, how: row.deleted_how }
      : null,
  };
}
export function write(
  store: DigestStore,
  provider: string,
  metadata: SessionMetadata,
  delta: DigestDelta,
  checkpoint?: DigestCheckpoint,
): void {
  const summary = delta.summary;
  const last = summary.last;
  const session: DigestSessionRecord = {
    ...usageRecord(summary.total, summary.revision),
    id: metadata.id,
    provider,
    parent_id: metadata.parentID ?? null,
    directory: metadata.directory,
    project_id: metadata.projectID,
    title: metadata.title,
    time_created: metadata.timeCreated,
    time_updated: metadata.timeUpdated,
    archived: metadata.archived ? 1 : 0,
    message_count: summary.messageCount ?? null,
    last_agent: last?.agent ?? null,
    last_provider: last?.model?.provider ?? null,
    last_model: last?.model?.model ?? null,
    context_input: last?.context?.input ?? null,
    context_output: last?.context?.output ?? null,
    context_reasoning: last?.context?.reasoning ?? null,
    context_cache_read: last?.context?.cache.read ?? null,
    context_cache_write: last?.context?.cache.write ?? null,
    state: summary.state,
    digested_at: summary.digestedAt ?? null,
    native_updated_at: summary.nativeUpdatedAt ?? null,
    deleted_at: delta.deleted?.at ?? null,
    deleted_how: delta.deleted?.how ?? null,
  };
  const turns: DigestTurnRecord[] = Object.entries(delta.turns.upsert).map((
    [turn_id, value],
  ) => ({
    ...usageRecord(value, summary.revision),
    session_id: metadata.id,
    turn_id,
    call_count: value.calls,
  }));
  const bookkeeping: DigestBookkeepingRecord[] = checkpoint
    ? [{
      session_id: metadata.id,
      last_message_id: checkpoint.lastMessage,
      last_message_hash: checkpoint.lastHash,
      generation: checkpoint.generation,
      dirty: checkpoint.dirty ? 1 : 0,
      digested_at: summary.digestedAt ?? null,
      native_updated_at: metadata.timeUpdated,
    }]
    : [];
  store.commit({
    sessions: [session],
    turns: {
      upsert: turns,
      remove: delta.turns.remove.map((turn_id) => ({
        session_id: metadata.id,
        turn_id,
      })),
    },
    bookkeeping,
  });
}
