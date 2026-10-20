// SPDX-License-Identifier: LGPL-3.0-only
import "./TurnUsage.css" with { type: "text" };
import { For, Show } from "solid-js";
import { type TurnUsage as Usage, usageCost, usageTokens } from "@otk/client";
import Popover from "./surface/Popover.tsx";
import { countLabel } from "./tools/count.ts";
import { elapsed } from "./work-log.ts";

/** Presentation only; the usage owner supplies every call, price and clock. */
export default function TurnUsage(
  props: { usage: Usage; showCost: boolean },
): import("solid-js").Element {
  const summary = () =>
    `${countLabel(props.usage.calls.length, "model call")} · ${
      countLabel(
        props.usage.tokens,
        "token",
        undefined,
        usageTokens(props.usage.tokens),
      )
    }${props.showCost ? ` · ${usageCost(props.usage.cost)}` : ""}`;
  const duration = (time: Usage["time"]) =>
    time?.end === undefined ? "—" : elapsed(time.start, time.end);
  return (
    <Popover
      class="otk-turn-usage"
      label="Turn usage"
      triggerLabel={`Turn usage: ${summary()}`}
      title="Turn usage"
      size="wide"
      preview
      trigger={<span>{summary()}</span>}
    >
      <table class="otk-usage-breakdown">
        <thead>
          <tr>
            <th scope="col">Call</th>
            <th scope="col">Activity</th>
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
                <td class="otk-usage-activity">{call().activity}</td>
                <For
                  each={call().categories}
                  keyed={(category) => category.label}
                >
                  {(category) => (
                    <td>{category().tokens.toLocaleString("en-US")}</td>
                  )}
                </For>
                <Show when={props.showCost}>
                  <td>{usageCost(call().cost)}</td>
                </Show>
                <td>{duration(call().time)}</td>
              </tr>
            )}
          </For>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colspan="2">Total</th>
            <For
              each={props.usage.categories}
              keyed={(category) => category.label}
            >
              {(category) => (
                <td>
                  <span>{category().tokens.toLocaleString("en-US")}</span>
                  <Show when={props.showCost && category().cost !== undefined}>
                    <small class="otk-usage-category-cost">
                      {usageCost(category().cost!)}
                    </small>
                  </Show>
                </td>
              )}
            </For>
            <Show when={props.showCost}>
              <td>{usageCost(props.usage.cost)}</td>
            </Show>
            <td>{duration(props.usage.time)}</td>
          </tr>
        </tfoot>
      </table>
      <Show
        when={props.showCost &&
          props.usage.categories.some((category) =>
            category.cost !== undefined
          )}
      >
        <p class="otk-usage-note">
          Category costs use model prices. The total is reported by the backend.
        </p>
      </Show>
    </Popover>
  );
}
