// SPDX-License-Identifier: LGPL-3.0-only
import "./EntityPill.css" with { type: "text" };
import { Show } from "solid-js";
import { derivedValue, type ModelRef } from "@otk/protocol";
import { duration } from "@otk/client";
import { useSessionPorts } from "../registries/session.tsx";
import Popover from "./surface/Popover.tsx";
import StatusLight from "./StatusLight.tsx";
import { LIGHT_STATES } from "./status-light.ts";

/** One agent label and fact preview, borrowing session data and navigation. */
export default function EntityPill(props: {
  label: string;
  sessionID?: string;
  model?: ModelRef;
  finished?: number;
  duration?: number;
  onOpen?(id: string): void;
}): import("solid-js").Element {
  const session = useSessionPorts();
  const entry = () =>
    props.sessionID ? session?.entry(props.sessionID) : undefined;
  const reported = () => derivedValue(entry()?.digest.last);
  const model = () => props.model ?? reported()?.model;
  const status = () =>
    props.sessionID ? session?.status?.(props.sessionID) : undefined;
  const time = () => derivedValue(entry()?.digest.helper?.progress)?.time;
  const finished = () => props.finished ?? time()?.end;
  const elapsed = () => {
    const value = time();
    return props.duration ??
      (value?.end !== undefined ? value.end - value.start : undefined);
  };
  const open = () => {
    if (props.sessionID) props.onOpen?.(props.sessionID);
  };
  return (
    <Popover
      label={`${props.label} details`}
      triggerLabel={props.sessionID && props.onOpen
        ? `Open ${props.label} session`
        : `${props.label} details`}
      class="otk-entity"
      triggerClass="otk-entity-pill"
      trigger={<span class="otk-control-label">{props.label}</span>}
      title={props.label}
      size="content"
      preview
      pinOnClick
      onActivate={props.sessionID && props.onOpen ? open : undefined}
    >
      <dl class="otk-entity-facts">
        <dt>Agent</dt>
        <dd>{props.label}</dd>
        <Show when={model()}>
          {(value) => (
            <>
              <dt>Model</dt>
              <dd>{value().provider} / {value().model}</dd>
            </>
          )}
        </Show>
        <Show when={props.sessionID}>
          {(id) => (
            <>
              <dt>Session</dt>
              <dd>{entry()?.title ?? id()}</dd>
            </>
          )}
        </Show>
        <Show when={status()}>
          {(value) => (
            <>
              <dt>Status</dt>
              <dd class="otk-entity-status">
                <StatusLight state={value()} small />
                {LIGHT_STATES[value()].label}
              </dd>
            </>
          )}
        </Show>
        <Show when={elapsed() !== undefined}>
          <dt>Duration</dt>
          <dd>{duration(elapsed()!)}</dd>
        </Show>
        <Show when={finished()}>
          {(value) => (
            <>
              <dt>Finished</dt>
              <dd>
                <time datetime={new Date(value()).toISOString()}>
                  {new Date(value()).toLocaleString()}
                </time>
              </dd>
            </>
          )}
        </Show>
      </dl>
      <Show when={props.sessionID && props.onOpen}>
        <button type="button" class="otk-pill" onClick={open}>Open</button>
      </Show>
    </Popover>
  );
}
