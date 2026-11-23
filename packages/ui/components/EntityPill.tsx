// SPDX-License-Identifier: LGPL-3.0-only
import "./EntityPill.css" with { type: "text" };
import Clock from "./Clock.tsx";
import { createMemo, Show } from "solid-js";
import {
  type ActionControl,
  type EntityFacts,
  entityTimeValue,
} from "@otk/client";
import TimeValue from "./TimeValue.tsx";
import Popover from "./surface/Popover.tsx";
import StatusLight from "./StatusLight.tsx";
import { LIGHT_STATES } from "./status-light.ts";
import { useCommandPorts } from "../keyboard/context.tsx";
import ActionButton from "./ActionButton.tsx";
import { sessionOpenControl } from "./session-open.ts";

/** Data-only shared preview. No session lookup or cross-scope fallback. */
export default function EntityPill(props: {
  label: string;
  facts: EntityFacts;
  open?: ActionControl;
}): import("solid-js").Element {
  const { commands } = useCommandPorts();
  const open = createMemo(() =>
    props.open ??
      (props.facts.session.id
        ? sessionOpenControl(
          commands,
          props.facts.session.id,
          props.facts.session.title ?? props.label,
        )
        : undefined)
  );
  const work = () => props.facts.reply ?? props.facts.tool;
  return (
    <Popover
      label={`${props.label} details`}
      triggerLabel={`${props.label} details`}
      class="otk-entity"
      triggerClass="otk-entity-pill"
      trigger={<span class="otk-control-label">{props.label}</span>}
      title={props.label}
      size="content"
      preview
      pinOnClick
    >
      <dl class="otk-entity-facts">
        <dt>Agent</dt>
        <dd>{props.label}</dd>
        <Show when={props.facts.model}>
          {(model) => (
            <>
              <dt>Model</dt>
              <dd>{model().provider} / {model().model}</dd>
            </>
          )}
        </Show>
        <Show when={work()}>
          {(value) => (
            <>
              <dt>{props.facts.reply ? "This reply" : "This tool"}</dt>
              <dd>
                <TimeValue
                  value={entityTimeValue(
                    value().working,
                    props.facts.reply?.explanation,
                  )}
                />
              </dd>
              <Show when={value().completed.known}>
                {
                  <>
                    <dt>Completed</dt>
                    <dd>
                      <Clock at={value().completed.value!} />
                    </dd>
                  </>
                }
              </Show>
            </>
          )}
        </Show>
        <Show when={props.facts.session.id}>
          {(id) => (
            <>
              <dt>Session</dt>
              <dd>{props.facts.session.title ?? id()}</dd>
            </>
          )}
        </Show>
        <Show when={props.facts.session.status}>
          {(status) => (
            <>
              <dt>Session now</dt>
              <dd class="otk-entity-status">
                <StatusLight state={status()} small />
                {LIGHT_STATES[status()].label}
              </dd>
            </>
          )}
        </Show>
      </dl>
      <Show when={open()}>
        {(action) => (
          <ActionButton action={action()} class="otk-pill">Open</ActionButton>
        )}
      </Show>
    </Popover>
  );
}
