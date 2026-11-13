// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionUsage, UsageMessage, UsageSummary } from "@otk/protocol";
import { knownDerived, type TurnUsageDetail, UsageLedger } from "@otk/protocol";
import type { IndexStore } from "../../core/index/store.ts";
import { TurnTimingAccumulator } from "@otk/harness";
/** These scripted external-harness fixtures declare each call interval busy. */
function fixtureTiming(calls: UsageMessage[]) {
  const owner = new TurnTimingAccumulator();
  for (const call of calls) {
    if (call.time) {
      owner.add({
        ...call.time,
        terminal: call.completed,
        source: "scripted-fixture",
        busy: call.time.end === undefined
          ? []
          : [{ start: call.time.start, end: call.time.end }],
        waits: [],
      });
    }
  }
  return owner.result();
}
/** External backend fixtures publish their summary contract independently of UI detail demand. */
export function turnDetail(
  value: SessionUsage,
  turnID: string,
  clock: TurnUsageDetail["clock"] = { epoch: "fixture", seq: 0 },
): TurnUsageDetail {
  const detail: TurnUsageDetail = {
    ...new UsageLedger(value.sessionID, value.messages).detail(turnID),
    version: { generation: 0, revision: 0 },
    clock,
  };
  detail.summary.timing = fixtureTiming(detail.calls);
  for (const call of detail.calls) call.timing = fixtureTiming([call]);
  return detail;
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
    timing: fixtureTiming(calls),
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
      total: knownDerived(
        summarize(value.total, value.messages),
        value.sessionID,
        revision,
      ),
      ...(last
        ? {
          last: knownDerived(
            { callID: last.id, model: last.model, context: last.tokens },
            last.id,
            revision,
          ),
        }
        : {}),
    },
    turns: {
      upsert: Object.fromEntries(
        Object.entries(value.turns).map((
          [id, turn],
        ) => [
          id,
          knownDerived(
            summarize(
              turn,
              value.messages.filter((call) => call.turnID === id),
            ),
            id,
            revision,
          ),
        ]),
      ),
      remove: [],
    },
    deleted: null,
  });
}
