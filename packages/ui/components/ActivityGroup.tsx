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
import ChromeMeta from "./ChromeMeta.tsx";

/** The same disclosure frame serves spans and their identical-record groups. */
export default function ActivityGroup(props: {
  group: Group;
  prefs: Preferences;
  onOpenChild?(id: string): void;
  body(): Element;
  breakouts?(): Element;
}): Element {
  const session = useOptionalSessionPorts();
  const [open, setOpen] = retainedDisclosure(
    "records",
    () => props.group.category ?? "record",
    () =>
      props.group.silent
        ? { ...props.prefs, expandRecords: false }
        : props.prefs,
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
    <Show when={!props.group.silent || open()}>
      <section
        class={["otk-tool-line otk-record-group", {
          "is-interval": props.group.interval,
        }]}
        data-background-interval={props.group.interval
          ? props.group.key
          : undefined}
        data-count={props.group.members.length}
        data-record-members={JSON.stringify(props.group.members)}
      >
        <Show
          when={props.group.interval || props.group.title || props.group.silent}
          fallback={props.breakouts?.()}
        >
          <TreeNode
            label={props.group.failureTitle ||
              (props.group.silent
                ? "Completion details"
                : props.group.title || "Details")}
            outgoing={props.group.direction === "outgoing"}
            open={open()}
            onOpen={setOpen}
            bodyVisible={open() || !!props.group.breakouts?.length}
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
                  <Show
                    when={props.group.interval}
                    fallback={
                      <span class="otk-tool-verb otk-control-label">
                        {props.group.silent
                          ? "Completion details"
                          : props.group.title}
                      </span>
                    }
                  >
                    <Show
                      when={props.group.title || !props.group.failureTitle}
                    >
                      <ChromeMeta class="otk-control-label">
                        {props.group.silent
                          ? "Completion details"
                          : props.group.title || "Details"}
                      </ChromeMeta>
                    </Show>
                    <Show when={props.group.failureTitle}>
                      <ChromeMeta class="otk-control-label otk-record-group-failures">
                        {props.group.failureTitle}
                      </ChromeMeta>
                    </Show>
                  </Show>
                  <Show when={props.group.detail}>
                    <span
                      class="otk-tool-brief otk-control-label"
                      title={props.group.detail}
                    >
                      {props.group.detail}
                    </span>
                  </Show>
                  <Show when={props.group.count}>
                    <ChromeMeta class="otk-record-group-count">
                      {props.group.count}
                    </ChromeMeta>
                  </Show>
                  <Show when={props.group.time}>
                    {(time) => (
                      <ChromeMeta
                        class="otk-record-group-time"
                        title={activityTimeRange(
                          time(),
                          (value) => new Date(value).toLocaleString(),
                        )}
                      >
                        {activityTimeRange(time(), clock)}
                      </ChromeMeta>
                    )}
                  </Show>
                </button>
                <Show when={props.group.child && props.onOpenChild}>
                  <EntityPill
                    label={props.group.child!.label}
                    facts={scopedEntityFacts(session, props.group.child!)}
                    onOpen={props.onOpenChild}
                  />
                </Show>
              </header>
            )}
            body={() => open() ? props.body() : props.breakouts?.()}
          />
        </Show>
      </section>
    </Show>
  );
}

/** A normal completion borrows the footer, with no standalone status label. */
export function CompletionToggle(
  props: { group: Group; prefs: Preferences; onReveal?(): void },
): Element {
  const [open, setOpen] = retainedDisclosure(
    "records",
    "record",
    () => ({ ...props.prefs, expandRecords: false }),
    undefined,
    undefined,
    props.group.key,
  );
  return (
    <span class="otk-record-completion">
      <TreeNode
        label="Completion details"
        open={open()}
        onOpen={(open) => {
          setOpen(open);
          if (open) props.onReveal?.();
        }}
        hasChildren
        header={() => null}
      />
    </span>
  );
}
