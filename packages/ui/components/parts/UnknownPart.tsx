// SPDX-License-Identifier: LGPL-3.0-only
import Clock from "../Clock.tsx";
import "../tools/ToolFrame.css" with { type: "text" };
import "./UnknownPart.css" with { type: "text" };
import { createMemo, For, Show } from "solid-js";
import type { ChildRef } from "@otk/protocol";
import type { PartProps, PartRegistry } from "../../registries/renderers.ts";
import {
  transcriptDisclosureIdentity,
  useContentIdentity,
} from "../../features/transcript-context.tsx";
import Blocks from "../Blocks.tsx";
import { TreeItem, TreeNode } from "../Tree.tsx";
import Icon from "../Icon.tsx";
import {
  unknownPartFailure,
  unknownPartHasPreview,
  unknownPartPresentation,
  unknownPartPreview,
  unknownPartSource,
} from "./unknown-part.ts";
import NativeSource from "./NativeSource.tsx";
import {
  errorFeedback,
  GENERIC_FAILURE_REASON,
  presentFailure,
} from "@otk/client";
import FailureContent from "../FailureContent.tsx";
import EntityPill from "../EntityPill.tsx";
import { useOptionalSessionPorts } from "../../registries/session.tsx";
import { scopedEntityFacts } from "../../entity-facts.ts";
import Disclosure, { useDisclosure } from "../Disclosure.tsx";

export function UnknownPart(props: PartProps): import("solid-js").Element {
  const session = useOptionalSessionPorts();
  const identity = useContentIdentity();
  const failure = () => {
    const value = unknownPartFailure(props.part, identity);
    return value
      ? presentFailure(value, { surface: "record", view: identity }).failure
      : activity()?.tone === "error"
      ? errorFeedback(activity()?.detail || GENERIC_FAILURE_REASON, {
        actionLabel: activity()?.title,
        target: identity,
      }, props.part)?.failure
      : undefined;
  };
  const activity = () =>
    props.part.kind === "external" ? props.part.activity : undefined;
  const identify = transcriptDisclosureIdentity();
  const input = () => ({
    category: activity()?.fold
      ? "record" as const
      : activity()?.category ?? "record" as const,
    prefs: () => props.prefs,
  });
  const choice = useDisclosure("record", identify, input);
  const reference = () => unknownPartSource(props.part);
  const name = () =>
    props.part.kind === "external"
      ? props.part.name
      : props.part.kind === "unknown"
      ? props.part.label || props.part.kind
      : props.part.kind;
  const details = () =>
    !!(props.recordTime !== undefined || activity()?.state ||
      activity()?.body?.length ||
      activity()?.parameters?.length || unknownPartHasPreview(props.part) ||
      reference());
  const expanded = () => details() && choice.open();
  const preview = createMemo(() =>
    expanded() ? unknownPartPreview(props.part) : undefined
  );
  const label = () => {
    const title = activity()?.title ?? `Unsupported part: ${name()}`;
    return title;
  };
  // A state already presented by the heading or a parameter is not repeated.
  const state = () => {
    const value = activity()?.state?.label;
    return value && value !== label() &&
        !activity()?.parameters?.some((p) => p.value === value)
      ? value
      : undefined;
  };
  const child = (ref: ChildRef) => (
    <EntityPill
      label={ref.label}
      facts={scopedEntityFacts(session, ref)}
    />
  );
  const heading = () => (
    <>
      <span class="otk-tool-brief otk-control-label" title={label()}>
        {label()}
      </span>
      <Show
        when={activity()?.detail && activity()?.detail !== failure()?.reason}
      >
        <span
          class="otk-tool-brief otk-control-label"
          title={activity()?.detail}
        >
          {activity()?.detail}
        </span>
      </Show>
    </>
  );
  const hasSource = () => !!(preview() || reference());
  return (
    <Show
      when={!activity() ? failure() : undefined}
      fallback={
        <section
          class={["otk-tool-line otk-native-record", {
            "is-error": activity()?.tone === "error",
            "is-open": !!expanded(),
          }]}
          data-native-record={name()}
          data-activity-state={activity()?.state?.key}
        >
          <Disclosure
            kind="record"
            identity={identify()}
            input={input()}
            variant="label"
            class="otk-tool-toggle"
            lead={() => (
              <Show when={activity()?.icon?.name === "warning"}>
                <span
                  class="otk-tool-icon"
                  role="img"
                  aria-label={activity()?.icon?.label ?? "Warning"}
                >
                  <Icon>
                    <path d="M12 3 2 21h20L12 3Z" />
                    <path d="M12 9v5m0 3v.01" />
                  </Icon>
                </span>
              </Show>
            )}
            label={label()}
            accessibleLabel={label()}
            labelContent={heading}
            hasContent={details}
            layout={({ trigger, region, open, frame }) => (
              <TreeNode
                class="otk-tool-row"
                heading={{ class: "otk-tool-state" }}
                ref={frame}
                trigger={{ variant: "span", element: trigger, hasBox: details }}
                outgoing={activity()?.direction === "outgoing"
                  ? true
                  : undefined}
                bodyVisible={open()}
                region={region}
                feedbackGutter={activity()?.direction !== "outgoing"}
                feedback={failure()
                  ? () => (
                    <FailureContent
                      placement="record"
                      subgrid={activity()?.direction !== "outgoing"}
                      failure={failure()!}
                      time={props.failureTime}
                    />
                  )
                  : undefined}
                trail={activity()?.entity || activity()?.child
                  ? () => (
                    <header class="otk-tool-state otk-control-row">
                      <Show when={activity()?.entity}>
                        {(entity) => (
                          <EntityPill
                            label={entity().label}
                            facts={scopedEntityFacts(session, entity())}
                          />
                        )}
                      </Show>
                      <Show when={activity()?.child}>
                        {(ref) => child(ref())}
                      </Show>
                    </header>
                  )
                  : undefined}
              />
            )}
          >
            {() => (
              <>
                <TreeItem last={!hasSource()}>
                  <TreeNode
                    header={() => (
                      <div class="otk-tool-body">
                        <Show when={state()}>
                          {(value) => <p>{value()}</p>}
                        </Show>
                        <dl
                          class="otk-native-parameters"
                          hidden={props.recordTime === undefined &&
                            !activity()?.parameters?.length}
                        >
                          <Show
                            when={props.recordTime !== undefined}
                          >
                            <dt>Recorded at</dt>
                            <dd>
                              <Clock
                                at={props.recordTime!}
                                precise
                                class="otk-native-value"
                                data-record-time=""
                              />
                            </dd>
                          </Show>
                          <For
                            each={activity()?.parameters}
                            keyed={(parameter) => parameter.key}
                          >
                            {(parameter) => (
                              <>
                                <dt>{parameter().label}</dt>
                                <dd>
                                  <Show
                                    when={parameter().entity}
                                    fallback={
                                      <Show
                                        when={parameter().child}
                                        fallback={
                                          <span class="otk-native-value">
                                            {parameter().value}
                                          </span>
                                        }
                                      >
                                        {(ref) => child(ref())}
                                      </Show>
                                    }
                                  >
                                    {(entity) => (
                                      <EntityPill
                                        label={entity().label}
                                        facts={scopedEntityFacts(
                                          session,
                                          entity(),
                                        )}
                                      />
                                    )}
                                  </Show>
                                </dd>
                              </>
                            )}
                          </For>
                        </dl>
                        <Show when={activity()?.body}>
                          {(body) => (
                            <Blocks
                              blocks={body()}
                              conceal={props.prefs.conceal}
                            />
                          )}
                        </Show>
                      </div>
                    )}
                  />
                </TreeItem>
                <Show when={hasSource()}>
                  <TreeItem last>
                    <NativeSource
                      reference={reference()}
                      preview={preview()}
                      prefs={props.prefs}
                    />
                  </TreeItem>
                </Show>
              </>
            )}
          </Disclosure>
        </section>
      }
    >
      {(value) => (
        <section
          class="otk-native-record"
          data-native-record={name()}
          role={value().value.facts?.outcome === "unknown" ||
              value().value.facts?.outcome === "unavailable"
            ? "status"
            : "alert"}
        >
          <FailureContent failure={value()} time={props.failureTime} />
        </section>
      )}
    </Show>
  );
}
export function registerUnknownPart(parts: PartRegistry): void {
  parts.fallback(UnknownPart, unknownPartPresentation);
}
