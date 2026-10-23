// SPDX-License-Identifier: LGPL-3.0-only
import "./TurnUsage.css" with { type: "text" };
import { createSignal, For, Show } from "solid-js";
import { type TurnUsage as Usage, usageCost, usageTokens } from "@otk/client";
import Popover from "./surface/Popover.tsx";
import { countLabel } from "./tools/count.ts";
import { elapsed } from "./work-log.ts";
import UsageCost from "./UsageCost.tsx";
import {
  contentOwner,
  useContentIdentity,
} from "../features/transcript-context.tsx";
import type { PopoverControl } from "./surface/Popover.tsx";

/** Presentation only; the usage owner supplies every call, price and clock. */
export default function TurnUsage(
  props: { usage: Usage; showCost: boolean },
): import("solid-js").Element {
  const [opened, setOpened] = createSignal(false);
  let popover!: PopoverControl;
  const identity = useContentIdentity();
  contentOwner(() => identity, { usage: () => popover.open() });
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
      triggerClass="otk-turn-usage-trigger"
      label="Turn usage"
      triggerLabel={`Turn usage: ${summary()}${
        props.showCost
          ? `; exact cost ${usageCost(props.usage.cost, "exact")}`
          : ""
      }`}
      title="Turn usage"
      size="wide"
      preview
      control={(control) => {
        popover = control;
      }}
      trigger={<span>{summary()}</span>}
      onOpen={() => setOpened(true)}
      onClose={() => setOpened(false)}
    >
      <Show when={opened()}>
        <div class="otk-usage-detail">
          <dl class="otk-usage-summary">
            <div data-usage-summary="calls">
              <dt>Model calls</dt>
              <dd>{props.usage.calls.length.toLocaleString("en-US")}</dd>
            </div>
            <div
              data-usage-summary="context"
              role="group"
              aria-label={`Context peak: ${
                props.usage.contextPeak.toLocaleString("en-US")
              } tokens`}
              title={`${
                props.usage.contextPeak.toLocaleString("en-US")
              } tokens`}
            >
              <dt>Context peak</dt>
              <dd>{usageTokens(props.usage.contextPeak)}</dd>
            </div>
            <div
              data-usage-summary="tokens"
              role="group"
              aria-label={`Total tokens: ${
                props.usage.tokens.toLocaleString("en-US")
              }`}
              title={`${props.usage.tokens.toLocaleString("en-US")} tokens`}
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
                          <span>{call().context.toLocaleString("en-US")}</span>
                          <span
                            class="otk-usage-context-bar"
                            aria-hidden="true"
                          >
                            <span
                              style={{
                                width: `${
                                  props.usage.contextPeak
                                    ? call().context / props.usage.contextPeak *
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
                        {(category) => (
                          <td>{category().tokens.toLocaleString("en-US")}</td>
                        )}
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
                  <td>{props.usage.context.toLocaleString("en-US")}</td>
                  <For
                    each={props.usage.categories}
                    keyed={(category) => category.label}
                  >
                    {(category) => (
                      <td>
                        <span>{category().tokens.toLocaleString("en-US")}</span>
                        <Show
                          when={props.showCost && category().cost !== undefined}
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
                props.usage.categories.some((category) =>
                  category.cost !== undefined
                )}
            >
              <p class="otk-usage-note">
                Category costs use model prices. The total is reported by the
                backend.
              </p>
            </Show>
          </div>
        </div>
      </Show>
    </Popover>
  );
}
