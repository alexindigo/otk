// SPDX-License-Identifier: LGPL-3.0-only
import "./TurnUsage.css" with { type: "text" };
import ScrollRegion from "./ScrollRegion.tsx";
import { For, Show } from "solid-js";
import { exactCount, type TurnUsage as Usage, usageTokens } from "@otk/client";
import { timingExplanation, workingTimeValue } from "./work-log.ts";
import TimeValue from "./TimeValue.tsx";
import UsageCost from "./UsageCost.tsx";
import { errorFeedback, type FailureValue } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";

/** Presentation only; the usage owner supplies every call, price and clock. */
export default function UsageDetail(
  props: { usage?: Usage; error?: string | FailureValue; showCost: boolean },
): import("solid-js").Element {
  const count = (value: number | null) =>
    value === null ? "Not reported" : exactCount(value);
  return (
    <div class="otk-usage-detail">
      <Show when={props.usage}>
        {(usage) => (
          <dl class="otk-usage-summary">
            <div data-usage-summary="calls">
              <dt>Model calls</dt>
              <dd>{exactCount(usage().calls.length)}</dd>
            </div>
            <div
              data-usage-summary="context"
              role="group"
              aria-label={`Context peak: ${count(usage().contextPeak)} tokens`}
              title={`${count(usage().contextPeak)} tokens`}
            >
              <dt>Context peak</dt>
              <dd>{usageTokens(usage().contextPeak)}</dd>
            </div>
            <div
              data-usage-summary="tokens"
              role="group"
              aria-label={`Total tokens: ${count(usage().tokens)}`}
              title={`${count(usage().tokens)} tokens`}
            >
              <dt>Total tokens</dt>
              <dd>{usageTokens(usage().tokens)}</dd>
            </div>
            <Show when={props.showCost}>
              <div data-usage-summary="cost">
                <dt>Total cost</dt>
                <dd>
                  <UsageCost value={usage().cost} />
                </dd>
              </div>
            </Show>
          </dl>
        )}
      </Show>
      {/* The focus target outlives loading, errors and complete ledger paint. */}
      <ScrollRegion
        class="otk-usage-scroll"
        tabindex={0}
        role="region"
        aria-label="Model calls"
      >
        <Show
          when={props.usage}
          fallback={props.error
            ? <FeedbackStatus feedback={errorFeedback(props.error)} />
            : <p>Loading usage breakdown...</p>}
        >
          {(usage) => (
            <table
              class="otk-usage-breakdown"
              role="table"
              style={{
                "--usage-metrics": usage().categories.length +
                  (props.showCost ? 3 : 2),
              }}
            >
              <thead role="rowgroup">
                <tr role="row">
                  <td
                    colspan="2"
                    role="presentation"
                    class="otk-usage-identity"
                  >
                    <span role="columnheader">Call</span>
                    <span role="columnheader">Activity</span>
                  </td>
                  <th scope="col">Context</th>
                  <For
                    each={usage().categories}
                    keyed={(category) => category.label}
                  >
                    {(category) => <th scope="col">{category().label}</th>}
                  </For>
                  <Show when={props.showCost}>
                    <th scope="col">Cost</th>
                  </Show>
                  <th scope="col">Time</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                <For each={usage().calls} keyed={(call) => call.id}>
                  {(call, index) => (
                    <tr role="row" data-call={call().id}>
                      <td
                        colspan="2"
                        role="presentation"
                        class="otk-usage-identity"
                      >
                        <span role="rowheader">{index() + 1}</span>
                        <span
                          class="otk-usage-activity"
                          role="cell"
                          aria-label={call().activity}
                          title={call().activity}
                        >
                          <span>{call().activity}</span>
                        </span>
                      </td>
                      <td>
                        <span class="otk-usage-context">
                          <span>{count(call().context)}</span>
                          <span
                            class="otk-usage-context-bar"
                            aria-hidden="true"
                          >
                            <span
                              style={{
                                width: `${
                                  usage().contextPeak && call().context !== null
                                    ? call().context! / usage().contextPeak! *
                                      100
                                    : 0
                                }%`,
                              }}
                            />
                          </span>
                        </span>
                      </td>
                      <For
                        each={call().categories}
                        keyed={(category) => category.label}
                      >
                        {(category) => <td>{count(category().tokens)}</td>}
                      </For>
                      <Show when={props.showCost}>
                        <td>
                          <UsageCost value={call().cost} />
                        </td>
                      </Show>
                      <td title={timingExplanation(call().timing)}>
                        <TimeValue
                          value={workingTimeValue(
                            call().timing,
                            undefined,
                            "column",
                          )}
                        />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
              <tfoot role="rowgroup">
                <tr role="row">
                  <th scope="row" colspan="2" aria-colspan={2}>Total</th>
                  <td>{count(usage().context)}</td>
                  <For
                    each={usage().categories}
                    keyed={(category) => category.label}
                  >
                    {(category) => (
                      <td>
                        <span>{count(category().tokens)}</span>
                        <Show
                          when={props.showCost && category().cost !== null}
                        >
                          <small class="otk-usage-category-cost">
                            <UsageCost value={category().cost!} />
                          </small>
                        </Show>
                      </td>
                    )}
                  </For>
                  <Show when={props.showCost}>
                    <td>
                      <UsageCost value={usage().cost} />
                    </td>
                  </Show>
                  <td title={timingExplanation(usage().timing)}>
                    <TimeValue
                      value={workingTimeValue(
                        usage().timing,
                        undefined,
                        "column",
                      )}
                    />
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </Show>
      </ScrollRegion>
      <Show when={props.usage}>
        {(usage) => (
          <div class="otk-usage-notes">
            <p class="otk-usage-note otk-usage-context-note">
              New input + Cache read + Cache write = Context.
            </p>
            <Show
              when={props.showCost &&
                usage().categories.some((category) => category.cost !== null)}
            >
              <p class="otk-usage-note">
                Category costs use model prices. The total is reported by the
                backend.
              </p>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
