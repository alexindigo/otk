// SPDX-License-Identifier: LGPL-3.0-only
import "./tools/ToolFrame.css" with { type: "text" };
import "./ActivityGroup.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import type { ActivityGroup as Group } from "@otk/client";
import { TreeNode } from "./Tree.tsx";
import EntityPill from "./EntityPill.tsx";
import { useOptionalSessionPorts } from "../registries/session.tsx";
import { scopedEntityFacts } from "../entity-facts.ts";
import type { Preferences } from "@otk/protocol";
import { transcriptDisclosureIdentity } from "../features/transcript-context.tsx";
import { activityTimeRange } from "./activity-time.ts";
import ChromeMeta, { metaList } from "./ChromeMeta.tsx";
import { clockText, clockTitle } from "./Clock.tsx";
import ContentSlot from "./ContentSlot.tsx";
import { ActivityIcon } from "./ChromeIcons.tsx";
import RecordRow from "./RecordRow.tsx";
import type { FittedAction } from "./FittedActions.tsx";
import Disclosure, { useDisclosure } from "./Disclosure.tsx";
import { useRecordKindsRegion } from "./RecordKinds.tsx";

/** The same disclosure frame serves spans and their identical-record groups. */
export default function ActivityGroup(props: {
  group: Group;
  prefs: Preferences;
  onOpenChild?(id: string): void;
  body(): Element;
  breakouts?(): Element;
  label?(open: () => boolean): Element;
  status?(open: () => boolean): Element;
  actions?(open: () => boolean): readonly FittedAction[];
  meta?(): Element;
  icon?(): Element;
  collapsible?: boolean;
  hasContent?(): boolean;
  disclosureKind?: "revert";
  failed?: boolean;
}): Element {
  const session = useOptionalSessionPorts();
  const identify = transcriptDisclosureIdentity();
  const kind = () =>
    props.disclosureKind ?? (props.group.silent ? "silent" : "activity");
  const identity = () => identify({ owner: props.group.key });
  const input = () => ({
    category: props.group.category ?? "record" as const,
    prefs: () => props.prefs,
  });
  const { open, chosen } = useDisclosure(kind, identity, input);
  const regionId = useRecordKindsRegion();
  const hasContent = () =>
    props.hasContent?.() ??
      !!(props.group.members.length || props.group.breakouts?.length);
  const title = () =>
    props.group.silent ? "Completion details" : props.group.title || "Details";
  const art = () => props.icon?.() ?? <ActivityIcon />;
  const trail = () => (
    <RecordRow
      intrinsic
      failed={props.failed}
      outgoing={props.group.direction === "outgoing"}
      status={props.status ? () => props.status?.(open) : undefined}
      actions={props.actions?.(open)}
    >
      <Show when={props.group.entity}>
        {(entity) => (
          <EntityPill
            label={entity().label}
            facts={scopedEntityFacts(session, entity())}
            onOpenChild={props.onOpenChild}
          />
        )}
      </Show>
      <Show when={props.group.child}>
        {(child) => (
          <EntityPill
            label={child().label}
            facts={scopedEntityFacts(session, child())}
            onOpenChild={props.onOpenChild}
          />
        )}
      </Show>
      <ContentSlot content={props.meta} />
    </RecordRow>
  );
  const heading = () => (
    <Show
      when={props.label}
      keyed
      fallback={
        <>
          <Show
            when={props.group.interval}
            fallback={
              <ChromeMeta class="otk-control-label">
                {props.group.silent ? "Completion details" : props.group.title}
              </ChromeMeta>
            }
          >
            <ChromeMeta class="otk-control-label">
              {metaList([
                props.group.silent ? "Completion details" : props.group.title,
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
  );
  const breakouts = () => !!props.group.breakouts?.length;
  const rowHeading = { class: "otk-record-group-heading" };
  const outgoing = () => props.group.direction === "outgoing";
  return (
    <Show
      when={(!props.group.silent || open() || chosen()) &&
        (hasContent() || props.collapsible === false)}
    >
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
          fallback={<ContentSlot content={props.breakouts} />}
        >
          <Show
            when={props.collapsible !== false}
            fallback={
              <TreeNode
                class="otk-activity-group"
                heading={rowHeading}
                outgoing={outgoing()}
                node={art}
                header={heading}
                trail={trail}
              />
            }
          >
            <Disclosure
              kind={kind()}
              identity={identity()}
              input={input()}
              variant="label"
              class="otk-tool-toggle otk-record-group-toggle"
              label={title()}
              labelContent={heading}
              lead={art}
              hasContent={hasContent}
              regionId={props.meta ? regionId : undefined}
              layout={({ trigger, region, open, frame }) => (
                <TreeNode
                  class="otk-activity-group"
                  heading={rowHeading}
                  ref={frame}
                  trigger={{ variant: "span", element: trigger }}
                  outgoing={outgoing()}
                  bodyVisible={open() || breakouts()}
                  trail={props.meta || props.group.entity ||
                      props.group.child || props.actions || props.status ||
                      props.failed
                    ? trail
                    : undefined}
                  region={() => (
                    <>
                      {region()}
                      <Show when={!open()}>
                        <ContentSlot content={props.breakouts} />
                      </Show>
                    </>
                  )}
                />
              )}
            >
              {() => props.body()}
            </Disclosure>
          </Show>
        </Show>
      </section>
    </Show>
  );
}
