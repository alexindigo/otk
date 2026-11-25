// SPDX-License-Identifier: LGPL-3.0-only
import "./EntityPill.css" with { type: "text" };
import { Show } from "solid-js";
import { duration, type EntityFacts } from "@otk/client";
import Popover from "./surface/Popover.tsx";
import StatusLight from "./StatusLight.tsx";
import { LIGHT_STATES } from "./status-light.ts";

/** Data-only shared preview. No session lookup or cross-scope fallback. */
export default function EntityPill(props: {
  label: string;
  facts: EntityFacts;
  onOpen?(id: string): void;
}): import("solid-js").Element {
  const open = () => {
    if (props.facts.session.id) props.onOpen?.(props.facts.session.id);
  };
  const work = () => props.facts.reply ?? props.facts.tool;
  return (
    <Popover
      label={`${props.label} details`}
      triggerLabel={props.facts.session.id && props.onOpen
        ? `Open ${props.label} session`
        : `${props.label} details`}
      class="otk-entity"
      triggerClass="otk-entity-pill"
      trigger={<span class="otk-control-label">{props.label}</span>}
      title={props.label}
      size="content"
      preview
      pinOnClick
      onActivate={props.facts.session.id && props.onOpen ? open : undefined}
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
              <dd title={props.facts.reply?.explanation}>
                {value().working.known
                  ? `Working time: ${duration(value().working.value!)}`
                  : "Time unknown"}
                <Show when={value().working.known && !value().working.final}>
                  {" "}
                  <em>counting...</em>
                </Show>
              </dd>
              <Show when={value().completed.known}>
                {
                  <>
                    <dt>Completed</dt>
                    <dd>
                      <time
                        datetime={new Date(value().completed.value!)
                          .toISOString()}
                      >
                        {new Date(value().completed.value!).toLocaleString()}
                      </time>
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
      <Show when={props.facts.session.id && props.onOpen}>
        <button type="button" class="otk-pill" onClick={open}>Open</button>
      </Show>
    </Popover>
  );
}
