// SPDX-License-Identifier: LGPL-3.0-only
import "./tools/ToolFrame.css" with { type: "text" };
import "./ActivityGroup.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import type { ActivityGroup as Group } from "@otk/client";
import { ChevronIcon } from "./ChromeIcons.tsx";
import EntityPill from "./EntityPill.tsx";
import { useOptionalSessionPorts } from "../registries/session.tsx";
import { scopedEntityFacts } from "../entity-facts.ts";

/** The same disclosure frame serves spans and their identical-record groups. */
export default function ActivityGroup(props: {
  group: Group;
  open: boolean;
  onToggle(): void;
  onOpenChild?(id: string): void;
  body(): Element;
}): Element {
  const session = useOptionalSessionPorts();
  const clock = (time: number) =>
    new Date(time).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  return (
    <section
      class="otk-tool-line otk-record-group"
      data-count={props.group.members.length}
    >
      <header class="otk-record-group-heading">
        <Show when={props.group.entity}>
          {(entity) => (
            <EntityPill
              label={entity().label}
              facts={scopedEntityFacts(session, entity())}
              onOpen={props.onOpenChild}
            />
          )}
        </Show>
        <button
          type="button"
          class="otk-tool-toggle otk-record-group-toggle"
          aria-expanded={props.open ? "true" : "false"}
          onClick={() => props.onToggle()}
        >
          <span
            class="otk-tool-icon otk-record-group-chevron"
            aria-hidden="true"
          >
            <ChevronIcon />
          </span>
          <span class="otk-tool-verb otk-control-label">
            {props.group.title}
          </span>
          <Show when={props.group.detail}>
            <span
              class="otk-tool-brief otk-control-label"
              title={props.group.detail}
            >
              {props.group.detail}
            </span>
          </Show>
          <Show when={props.group.count}>
            <span class="otk-record-group-count">{props.group.count}</span>
          </Show>
          <Show when={props.group.time}>
            {(time) => (
              <span
                class="otk-record-group-time"
                title={`${new Date(time().first).toLocaleString()} - ${
                  new Date(time().last).toLocaleString()
                }`}
              >
                {clock(time().first)} - {clock(time().last)}
              </span>
            )}
          </Show>
        </button>
      </header>
      <Show when={props.open}>
        <div class="otk-record-group-children">{props.body()}</div>
      </Show>
    </section>
  );
}
