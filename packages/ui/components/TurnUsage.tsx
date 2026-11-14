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
import { type Derived, derivedValue, type UsageSummary } from "@otk/protocol";
import Popover, { type PopoverControl } from "./surface/Popover.tsx";
import UsageDetail from "./UsageDetail.tsx";
/** Cheap index summary; only opening acquires the injected detail lifetime. */
export default function TurnUsage(props: {
  summary?: Derived<UsageSummary>;
  showCost: boolean;
  detail(): Usage | undefined;
  error?(): import("@otk/client").FailureValue | undefined;
  open?(): () => void;
  control?(control: { open(): void }): void;
}): import("solid-js").Element {
  const [opened, setOpened] = createSignal(false);
  let release: (() => void) | undefined;
  const close = () => {
    setOpened(false);
    release?.();
    release = undefined;
  };
  onCleanup(close);
  const summary = () => {
    const value = derivedValue(props.summary);
    if (!value) {
      return props.summary?.state === "unavailable"
        ? "Usage unavailable"
        : "Digesting\u2026";
    }
    const tokens = reportedTokens(value.tokens);
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
      props.showCost && derivedValue(props.summary)?.cost != null
        ? `; exact cost ${
          usageCost(derivedValue(props.summary)!.cost!, "exact")
        }`
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
              props.control?.({ open: () => popover.open() });
            }}
            trigger={<span>{summary()}</span>}
            onOpen={() => {
              setOpened(true);
              release ??= props.open?.();
            }}
            onClose={close}
          >
            <UsageDetail
              usage={opened() && !props.error?.() ? props.detail() : undefined}
              error={opened() ? props.error?.() : undefined}
              showCost={props.showCost}
            />
          </Popover>
        );
      }}
    </Show>
  );
}
