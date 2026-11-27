// SPDX-License-Identifier: LGPL-3.0-only
import "./EntityPill.css" with { type: "text" };
import Clock from "./Clock.tsx";
import { createMemo, Show } from "solid-js";
import {
  type ActionControl,
  type EntityFacts,
  type EntityStateStore,
  entityTimeValue,
  hashFor,
  label,
  lamp,
  type Selection,
} from "@otk/client";
import { entityKey } from "@otk/protocol";
import TimeValue from "./TimeValue.tsx";
import Popover from "./surface/Popover.tsx";
import StatusLight from "./StatusLight.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import ActionButton from "./ActionButton.tsx";
import { sessionOpenControl, sessionSelectionControl } from "./session-open.ts";

/** Data-only shared preview. No session lookup or cross-scope fallback. */
export default function EntityPill(
  props:
    & { label: string }
    & (
      | {
        facts: EntityFacts;
        open?: ActionControl;
        onOpenChild?(id: string): void;
        reference?: never;
      }
      | {
        reference: Selection & {
          sourceID: string;
          entities?: EntityStateStore;
          fail?(cause: unknown): void;
        };
        facts?: never;
        open?: never;
        onOpenChild?: never;
      }
    ),
): import("solid-js").Element {
  const { commands } = useCommandPorts();
  const open = createMemo(() =>
    props.open ??
      (props.facts?.session.id
        ? sessionOpenControl(
          commands,
          props.facts.session.id,
          props.facts.session.title ?? props.label,
          props.onOpenChild,
        )
        : undefined)
  );
  const work = () => props.facts?.reply ?? props.facts?.tool;
  const activate = () => {
    const target = props.reference;
    if (target) {
      void sessionSelectionControl(commands, {
        sidecarId: target.sidecarId,
        sessionID: target.sessionID,
      }, props.label).run().then((result) => {
        if (result.kind === "failed") target.fail?.(result.feedback);
      });
    }
  };
  const state = () =>
    lamp(
      props.facts?.session.entities,
      props.facts?.session.id
        ? entityKey("session", props.facts.session.id)
        : undefined,
    );
  return (
    <Popover
      label={props.reference ? props.label : `${props.label} details`}
      class={props.reference ? "otk-entity otk-entity-reference" : "otk-entity"}
      triggerClass="otk-entity-pill otk-pill-surface"
      trigger={
        <>
          <Show when={props.reference}>
            {(target) => (
              <>
                <span class="otk-entity-lamp">
                  <StatusLight
                    state={lamp(
                      target().entities,
                      entityKey("session", target().sessionID),
                    )}
                    small
                  />
                </span>
              </>
            )}
          </Show>
          <span class="otk-control-label">{props.label}</span>
        </>
      }
      title={props.label}
      size="content"
      preview
      pinOnClick={!props.reference}
      href={props.reference && hashFor(props.reference)}
      onActivate={props.reference && activate}
      panelRole={props.reference ? "tooltip" : undefined}
      copySource={props.reference?.sourceID}
    >
      <Show when={props.reference}>
        {(target) => <span>{target().sourceID}</span>}
      </Show>
      <Show when={props.facts}>
        {(facts) => (
          <>
            <dl class="otk-entity-facts">
              <dt>Agent</dt>
              <dd>{props.label}</dd>
              <Show when={facts().model}>
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
                    <dt>{facts().reply ? "This reply" : "This tool"}</dt>
                    <dd>
                      <TimeValue
                        value={entityTimeValue(
                          value().working,
                          facts().reply?.explanation,
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
              <Show when={facts().session.id}>
                {(id) => (
                  <>
                    <dt>Session</dt>
                    <dd>{facts().session.title ?? id()}</dd>
                  </>
                )}
              </Show>
              <Show when={facts().session.id}>
                {(_id) => (
                  <>
                    <dt>Session now</dt>
                    <dd class="otk-entity-status">
                      <StatusLight state={state()} small />
                      {label(state())}
                    </dd>
                  </>
                )}
              </Show>
            </dl>
            <Show when={open()}>
              {(action) => (
                <ActionButton action={action()} class="otk-pill">
                  Open
                </ActionButton>
              )}
            </Show>
          </>
        )}
      </Show>
    </Popover>
  );
}
