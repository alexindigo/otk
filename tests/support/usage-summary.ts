// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionUsage, UsageMessage, UsageSummary } from "@otk/protocol";
import { type TurnUsageDetail, UsageLedger } from "@otk/protocol";
import type { IndexStore } from "../../core/index/store.ts";
/** External backend fixtures publish their summary contract independently of UI detail demand. */
export function turnDetail(
  value: SessionUsage,
  turnID: string,
  clock: TurnUsageDetail["clock"] = { epoch: "fixture", seq: 0 },
): TurnUsageDetail {
  return {
    ...new UsageLedger(value.sessionID, value.messages).detail(turnID),
    version: { generation: 0, revision: 0 },
    clock,
  };
}
export function publishUsage(
  index: IndexStore,
  input: SessionUsage | TurnUsageDetail,
): void {
  const value = "calls" in input
    ? new UsageLedger(input.sessionID, input.calls).snapshot()
    : input;
  const summarize = (
    total: SessionUsage["total"],
    calls: UsageMessage[],
  ): UsageSummary => ({
    tokens: total.tokens,
    cost: total.cost,
    time: total.time,
    calls: calls.length,
    contextPeak:
      calls.some((call) =>
          [call.tokens.input, call.tokens.cache.read, call.tokens.cache.write]
            .includes(null)
        )
        ? null
        : Math.max(
          0,
          ...calls.map((call) =>
            call.tokens.input! + call.tokens.cache.read! +
            call.tokens.cache.write!
          ),
        ),
  });
  const old = index.get(value.sessionID);
  if (!old) throw new Error("Fixture summary requires catalog metadata");
  const revision = old.digest.revision + 1;
  const last = value.messages.toSorted((a, b) =>
    (a.time?.start ?? 0) - (b.time?.start ?? 0) || a.id.localeCompare(b.id)
  ).at(-1);
  index.applyDigest({
    id: value.sessionID,
    revision,
    summary: {
      state: "ready",
      revision,
      total: summarize(value.total, value.messages),
      ...(last ? { last: { model: last.model, context: last.tokens } } : {}),
    },
    turns: {
      upsert: Object.fromEntries(
        Object.entries(value.turns).map((
          [id, turn],
        ) => [
          id,
          summarize(turn, value.messages.filter((call) => call.turnID === id)),
        ]),
      ),
      remove: [],
    },
    deleted: null,
  });
}
