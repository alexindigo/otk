// SPDX-License-Identifier: LGPL-3.0-only
import "./TurnUsage.css" with { type: "text" };
import { For, Show } from "solid-js";
import { exactCount, type TurnUsage as Usage, usageTokens } from "@otk/client";
import { elapsed } from "./work-log.ts";
import UsageCost from "./UsageCost.tsx";

/** Presentation only; the usage owner supplies every call, price and clock. */
export default function UsageDetail(
  props: { usage: Usage; showCost: boolean },
): import("solid-js").Element {
  const duration = (time: Usage["time"]) =>
    time?.end === undefined ? "—" : elapsed(time.start, time.end);
  const count = (value: number | null) =>
    value === null ? "Not reported" : exactCount(value);
  return (
    <div class="otk-usage-detail">
      <dl class="otk-usage-summary">
        <div data-usage-summary="calls">
          <dt>Model calls</dt>
          <dd>{exactCount(props.usage.calls.length)}</dd>
        </div>
        <div
          data-usage-summary="context"
          role="group"
          aria-label={`Context peak: ${count(props.usage.contextPeak)} tokens`}
          title={`${count(props.usage.contextPeak)} tokens`}
        >
          <dt>Context peak</dt>
          <dd>{usageTokens(props.usage.contextPeak)}</dd>
        </div>
        <div
          data-usage-summary="tokens"
          role="group"
          aria-label={`Total tokens: ${count(props.usage.tokens)}`}
          title={`${count(props.usage.tokens)} tokens`}
        >
          <dt>Total tokens</dt>
          <dd>{usageTokens(props.usage.tokens)}</dd>
        </div>
        <Show when={props.showCost}>
          <div data-usage-summary="cost">
            <dt>Total cost</dt>
            <dd>
              <UsageCost value={props.usage.cost} />
            </dd>
          </div>
        </Show>
      </dl>
      <div
        class="otk-usage-scroll"
        tabindex={0}
        role="region"
        aria-label="Model calls"
      >
        <table class="otk-usage-breakdown">
          <thead>
            <tr>
              <th scope="col">Call</th>
              <th scope="col">Activity</th>
              <th scope="col">Context</th>
              <For
                each={props.usage.categories}
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
          <tbody>
            <For each={props.usage.calls} keyed={(call) => call.id}>
              {(call, index) => (
                <tr data-call={call().id}>
                  <th scope="row">{index() + 1}</th>
                  <td
                    class="otk-usage-activity"
                    aria-label={call().activity}
                    title={call().activity}
                  >
                    <span>{call().activity}</span>
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
                              props.usage.contextPeak && call().context !== null
                                ? call().context! / props.usage.contextPeak *
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
                  <td>{duration(call().time)}</td>
                </tr>
              )}
            </For>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colspan="2">Total</th>
              <td>{count(props.usage.context)}</td>
              <For
                each={props.usage.categories}
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
                  <UsageCost value={props.usage.cost} />
                </td>
              </Show>
              <td>{duration(props.usage.time)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="otk-usage-notes">
        <p class="otk-usage-note otk-usage-context-note">
          New input + Cache read + Cache write = Context.
        </p>
        <Show
          when={props.showCost &&
            props.usage.categories.some((category) => category.cost !== null)}
        >
          <p class="otk-usage-note">
            Category costs use model prices. The total is reported by the
            backend.
          </p>
        </Show>
      </div>
    </div>
  );
}
