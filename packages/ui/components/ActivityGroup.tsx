// SPDX-License-Identifier: LGPL-3.0-only
import "./tools/ToolFrame.css" with { type: "text" };
import "./ActivityGroup.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import type { ActivityGroup as Group } from "@otk/client";
import { TreeIcon, TreeNode } from "./Tree.tsx";
import EntityPill from "./EntityPill.tsx";
import { useOptionalSessionPorts } from "../registries/session.tsx";
import { scopedEntityFacts } from "../entity-facts.ts";
import type { Preferences } from "@otk/protocol";
import { retainedDisclosure } from "../features/transcript-context.tsx";
import { activityTimeRange } from "./activity-time.ts";

/** The same disclosure frame serves spans and their identical-record groups. */
export default function ActivityGroup(props: {
  group: Group;
  prefs: Preferences;
  onOpenChild?(id: string): void;
  body(): Element;
}): Element {
  const session = useOptionalSessionPorts();
  const [open, setOpen] = retainedDisclosure(
    "records",
    () => props.group.category ?? "record",
    () => props.prefs,
    undefined,
    undefined,
    props.group.key,
  );
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
      <TreeNode
        label={props.group.title}
        outgoing={props.group.direction === "outgoing"}
        open={open()}
        onOpen={setOpen}
        header={() => (
          <header class="otk-record-group-heading">
            <TreeIcon />
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
              aria-expanded={open() ? "true" : "false"}
              onClick={() => setOpen(!open())}
            >
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
                    title={activityTimeRange(
                      time(),
                      (value) => new Date(value).toLocaleString(),
                    )}
                  >
                    {activityTimeRange(time(), clock)}
                  </span>
                )}
              </Show>
            </button>
          </header>
        )}
        body={props.body}
      />
    </section>
  );
}
