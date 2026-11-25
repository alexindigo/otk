// SPDX-License-Identifier: LGPL-3.0-only
import "./EntityPill.css" with { type: "text" };
import Clock from "./Clock.tsx";
import { createMemo, Show } from "solid-js";
import {
  type ActionControl,
  createEntityStateStore,
  type EntityFacts,
  entityTimeValue,
  label,
  lamp,
} from "@otk/client";
import { entityKey } from "@otk/protocol";
import TimeValue from "./TimeValue.tsx";
import Popover from "./surface/Popover.tsx";
import StatusLight from "./StatusLight.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import ActionButton from "./ActionButton.tsx";
import { sessionOpenControl } from "./session-open.ts";

const absent = createEntityStateStore({ read: () => undefined });

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
  const state = () =>
    lamp(
      props.facts.session.entities ?? absent,
      entityKey("session", props.facts.session.id ?? ""),
    );
  return (
    <Popover
      label={`${props.label} details`}
      triggerLabel={`${props.label} details`}
      class="otk-entity"
      triggerClass="otk-entity-pill otk-pill-surface"
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
        <Show when={props.facts.session.id}>
          {(_id) => (
            <>
              <dt>Session now</dt>
              <dd class="otk-entity-status">
                <StatusLight
                  state={lamp(
                    props.facts.session.entities ?? absent,
                    entityKey("session", props.facts.session.id ?? ""),
                  )}
                  small
                />
                {label(state())}
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
