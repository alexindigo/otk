// SPDX-License-Identifier: LGPL-3.0-only
import "./TurnUsage.css" with { type: "text" };
import { createSignal, onCleanup, Show } from "solid-js";
import {
  countLabel,
  reportedTokens,
  type TurnUsage as Usage,
  usageCost,
  usageTokens,
} from "@otk/client";
import type { UsageSummary } from "@otk/protocol";
import Popover, { type PopoverControl } from "./surface/Popover.tsx";
import UsageDetail from "./UsageDetail.tsx";
import {
  contentOwner,
  useContentIdentity,
} from "../features/transcript-context.tsx";
/** Cheap index summary; only opening acquires the injected detail lifetime. */
export default function TurnUsage(props: {
  summary?: UsageSummary;
  state?: string;
  showCost: boolean;
  detail(): Usage | undefined;
  error?(): string | undefined;
  open?(): () => void;
}): import("solid-js").Element {
  const [opened, setOpened] = createSignal(false);
  let release: (() => void) | undefined;
  const close = () => {
    setOpened(false);
    release?.();
    release = undefined;
  };
  onCleanup(close);
  const identity = useContentIdentity();
  const summary = () => {
    if (props.state !== "ready" || !props.summary) {
      return props.state === "unavailable" ? "Usage unavailable" : "Digesting…";
    }
    const value = props.summary, tokens = reportedTokens(value.tokens);
    return `${countLabel(value.calls, "model call")} · ${
      tokens === undefined
        ? "Tokens unavailable"
        : countLabel(tokens, "token", undefined, usageTokens(tokens))
    }${
      props.showCost
        ? ` · ${
          value.cost === null ? "Cost unavailable" : usageCost(value.cost)
        }`
        : ""
    }`;
  };
  const label = () =>
    `Turn usage: ${summary()}${
      props.state === "ready" && props.showCost && props.summary?.cost != null
        ? `; exact cost ${usageCost(props.summary.cost, "exact")}`
        : ""
    }`;
  return (
    <Show
      when={!!props.open}
      fallback={
        <span class="otk-control-label" role="group" aria-label={label()}>
          {summary()}
        </span>
      }
    >
      {(_available) => {
        let popover!: PopoverControl;
        contentOwner(() => identity, {
          get usage() {
            return props.open ? () => popover.open() : undefined;
          },
        });
        return (
          <Popover
            class="otk-turn-usage"
            triggerClass="otk-turn-usage-trigger"
            label="Turn usage"
            triggerLabel={label()}
            title="Turn usage"
            size="wide"
            preview
            control={(value) => {
              popover = value;
            }}
            trigger={<span>{summary()}</span>}
            onOpen={() => {
              setOpened(true);
              release ??= props.open?.();
            }}
            onClose={close}
          >
            <Show when={opened()}>
              <Show
                when={!props.error?.()}
                fallback={<p role="status">{props.error?.()}</p>}
              >
                <Show
                  when={props.detail()}
                  fallback={
                    <p>{props.error?.() ?? "Loading usage breakdown…"}</p>
                  }
                >
                  {(detail) => (
                    <UsageDetail usage={detail()} showCost={props.showCost} />
                  )}
                </Show>
              </Show>
            </Show>
          </Popover>
        );
      }}
    </Show>
  );
}
