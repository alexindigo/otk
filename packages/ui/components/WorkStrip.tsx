// SPDX-License-Identifier: LGPL-3.0-only
import { type ActionControl, countLabel, elapsed } from "@otk/client";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { WorkLogIcon } from "./ChromeIcons.tsx";
import { MetaItem, MetaRow } from "./ChromeMeta.tsx";
import { agentSwatch } from "../theme/agent-color.ts";
import type { WorkRuns, WorkSegment } from "./work-log.ts";
import ActionButton from "./ActionButton.tsx";
import { location } from "./selection.ts";
import TimeText from "./TimeText.tsx";
import "./WorkStrip.css" with { type: "text" };

/** One native control; segments are pointer targets, not extra tab stops. */
export default function WorkStrip(props: {
  runs: WorkRuns;
  shown: boolean;
  action(run?: string): ActionControl;
  onFeedback?: Parameters<typeof ActionButton>[0]["onFeedback"];
}) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => !!props.runs.live, (live) => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const segmentValue = <T extends "weightMs" | "title">(
    segment: WorkSegment,
    key: T,
  ): WorkSegment[T] => {
    if (segment.live) now();
    return segment[key];
  };
  return (
    <ActionButton
      location={location({
        current: props.shown,
        value: "true",
        class: "otk-work-strip",
      })}
      label={props.runs.summary}
      action={props.action()}
      onFeedback={props.onFeedback}
      hitAction={(event) => {
        const target = event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-run]")
          : null;
        return props.action(
          event instanceof MouseEvent && event.detail !== 0
            ? target?.dataset.run
            : props.runs.failed[0]?.key,
        );
      }}
    >
      <WorkLogIcon />
      <span class="otk-control-label">Work log</span>
      <span
        class="otk-work-strip-track"
        aria-hidden="true"
        style={{ "--work-segments": props.runs.segments.length }}
      >
        <For each={props.runs.segments}>
          {(segment) => (
            <span
              class={["otk-work-strip-segment", `is-${segment.lane}`, {
                "is-live": segment.live,
                "is-failed": segment.failed,
              }]}
              data-run={segment.run}
              title={segmentValue(segment, "title")}
              style={{
                "--work-weight": segmentValue(segment, "weightMs"),
                "--work-agent-color": agentSwatch(segment.agent),
              }}
            />
          )}
        </For>
      </span>
      <MetaRow class="otk-work-strip-summary">
        <Show
          when={props.runs.live}
          fallback={
            <MetaItem rank={1}>
              {countLabel(props.runs.actions, "action")}
              <Show when={props.runs.failed.length}>
                <span class="otk-work-strip-failed">
                  , {props.runs.failed.length} failed
                </span>
              </Show>
            </MetaItem>
          }
        >
          {(run) => (
            <>
              <span class="otk-control-label" title={run().label}>
                {run().label}
              </span>
              <MetaItem rank={1}>
                <TimeText time={elapsed(Math.max(0, now() - run().start!))} />
              </MetaItem>
            </>
          )}
        </Show>
      </MetaRow>
    </ActionButton>
  );
}
