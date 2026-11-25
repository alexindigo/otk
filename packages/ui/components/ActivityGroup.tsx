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
import ChromeMeta, { metaList } from "./ChromeMeta.tsx";
import { clockText, clockTitle } from "./Clock.tsx";
import ContentSlot from "./ContentSlot.tsx";
import FailureSignal from "./FailureSignal.tsx";
import { discloseInViewport } from "./viewport.ts";

/** The same disclosure frame serves spans and their identical-record groups. */
export default function ActivityGroup(props: {
  group: Group;
  prefs: Preferences;
  onOpenChild?(id: string): void;
  body(): Element;
  breakouts?(): Element;
  label?(open: () => boolean): Element;
  trailing?(open: () => boolean): Element;
  meta?(primary: () => Element): Element;
  icon?(): Element;
  collapsible?: boolean;
  failed?: boolean;
  wrapActions?: boolean;
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
  let frame: HTMLElement | undefined;
  const change = (value: boolean, event: MouseEvent | KeyboardEvent) =>
    discloseInViewport(
      frame,
      value,
      setOpen,
      event.isTrusted && value !== open(),
    );
  const header = (toggleID: string) => (
    <FailureSignal
      as="div"
      placement="gutter"
      enabled={props.failed === true}
      class={props.wrapActions
        ? "otk-record-group-heading wraps-actions"
        : "otk-record-group-heading"}
    >
      {heading(toggleID)}
    </FailureSignal>
  );
  const heading = (toggleID: string) => (
    <>
      <TreeIcon>{props.icon?.()}</TreeIcon>
      <Show when={props.group.entity}>
        {(entity) => (
          <EntityPill
            label={entity().label}
            facts={scopedEntityFacts(session, entity())}
            onOpenChild={props.onOpenChild}
          />
        )}
      </Show>
      <Show
        when={props.collapsible !== false}
        fallback={
          <span class="otk-record-group-toggle otk-control-label">
            <ContentSlot
              content={() => props.label?.(open) ?? props.group.title}
            />
          </span>
        }
      >
        <button
          id={toggleID}
          type="button"
          class="otk-tool-toggle otk-record-group-toggle otk-tree-control"
          aria-expanded={open() ? "true" : "false"}
          onClick={(event) => change(!open(), event)}
        >
          <Show
            when={props.label}
            keyed
            fallback={
              <>
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
                  <ChromeMeta class="otk-control-label">
                    {metaList([
                      props.group.silent
                        ? "Completion details"
                        : props.group.title,
                      props.group.failureTitle,
                    ]) || "Details"}
                  </ChromeMeta>
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
                      title={activityTimeRange(time(), clockTitle)}
                    >
                      {activityTimeRange(time(), clockText)}
                    </ChromeMeta>
                  )}
                </Show>
              </>
            }
          >
            {(label) => label(open)}
          </Show>
        </button>
      </Show>
      <Show when={props.group.child}>
        <EntityPill
          label={props.group.child!.label}
          facts={scopedEntityFacts(session, props.group.child!)}
          onOpenChild={props.onOpenChild}
        />
      </Show>
      {props.trailing?.(open)}
    </>
  );
  return (
    <Show when={!props.group.silent || open()}>
      <section
        ref={(element) => frame = element}
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
            toggleHeader={props.collapsible !== false}
            label={props.group.failureTitle ||
              (props.group.silent
                ? "Completion details"
                : props.group.title || "Details")}
            outgoing={props.group.direction === "outgoing"}
            open={open()}
            onOpen={props.collapsible === false ? undefined : change}
            bodyVisible={props.collapsible !== false &&
              (open() || !!props.group.breakouts?.length)}
            header={(_connected, toggleID) =>
              props.meta
                ? props.meta(() => header(toggleID))
                : header(toggleID)}
            body={() => (
              <Show
                when={open() && props.collapsible !== false
                  ? props.body
                  : undefined}
                keyed
                fallback={<ContentSlot content={props.breakouts} />}
              >
                {(body) => body()}
              </Show>
            )}
          />
        </Show>
      </section>
    </Show>
  );
}

/** A normal completion borrows the footer, with no standalone status label. */
export function CompletionToggle(
  props: { group: Group; prefs: Preferences; onReveal?(user: boolean): void },
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
        onOpen={(open, event) => {
          setOpen(open);
          if (open) props.onReveal?.(event.isTrusted);
        }}
        hasChildren
        header={() => null}
      />
    </span>
  );
}
