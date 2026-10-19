// SPDX-License-Identifier: LGPL-3.0-only
import "./TurnUsage.css" with { type: "text" };
import { For, Show } from "solid-js";
import { type TurnUsage as Usage, usageCost, usageTokens } from "@otk/client";
import Popover from "./surface/Popover.tsx";
import { countLabel } from "./tools/count.ts";

/** Presentation only; the reply owner supplies the charged turn's projection. */
export default function TurnUsage(
  props: { usage: Usage; showCost: boolean },
): import("solid-js").Element {
  const summary = () =>
    `${
      countLabel(
        props.usage.tokens,
        "token",
        undefined,
        usageTokens(props.usage.tokens),
      )
    }${props.showCost ? ` · ${usageCost(props.usage.cost)}` : ""}`;
  return (
    <Popover
      class="otk-turn-usage"
      label="Turn usage"
      triggerLabel={`Turn usage: ${summary()}`}
      title="Turn usage"
      preview
      trigger={<span>{summary()}</span>}
    >
      <table class="otk-usage-breakdown">
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Tokens</th>
            <Show
              when={props.showCost &&
                props.usage.categories.some((c) => c.cost !== undefined)}
            >
              <th scope="col">Cost</th>
            </Show>
          </tr>
        </thead>
        <tbody>
          <For
            each={props.usage.categories}
            keyed={(category) => category.label}
          >
            {(category) => (
              <tr>
                <th scope="row">{category().label}</th>
                <td>{category().tokens.toLocaleString("en-US")}</td>
                <Show
                  when={props.showCost &&
                    props.usage.categories.some((c) => c.cost !== undefined)}
                >
                  <td>
                    {category().cost === undefined
                      ? "Unknown"
                      : usageCost(category().cost!)}
                  </td>
                </Show>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show
        when={props.showCost &&
          props.usage.categories.some((c) => c.cost !== undefined)}
      >
        <p class="otk-usage-note">
          Category costs use model prices. The total is reported by the backend.
        </p>
      </Show>
    </Popover>
  );
}
