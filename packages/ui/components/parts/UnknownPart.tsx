// SPDX-License-Identifier: LGPL-3.0-only
import "../tools/ToolFrame.css" with { type: "text" };
import "./UnknownPart.css" with { type: "text" };
import { createMemo, For, Show } from "solid-js";
import type { ChildRef } from "@otk/protocol";
import type { PartProps, PartRegistry } from "../../registries/renderers.ts";
import {
  retainedDisclosure,
  useContentIdentity,
} from "../../features/transcript-context.tsx";
import Blocks from "../Blocks.tsx";
import { TreeIcon, TreeItem, TreeNode } from "../Tree.tsx";
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

export function UnknownPart(props: PartProps): import("solid-js").Element {
  const session = useOptionalSessionPorts();
  const identity = useContentIdentity();
  const failure = () => {
    const value = unknownPartFailure(props.part, identity);
    return value
      ? presentFailure(value, "record").failure
      : activity()?.tone === "error"
      ? errorFeedback(activity()?.detail || GENERIC_FAILURE_REASON, {
        actionLabel: activity()?.title,
        target: identity,
      })?.failure
      : undefined;
  };
  const activity = () =>
    props.part.kind === "external" ? props.part.activity : undefined;
  const [expanded, setExpanded] = retainedDisclosure(
    "activity",
    () => activity()?.category ?? "record",
    () => props.prefs,
  );
  const preview = createMemo(() =>
    expanded() ? unknownPartPreview(props.part) : undefined
  );
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
      onOpen={props.onOpenChild}
    />
  );
  const heading = () => (
    <>
      <span class="otk-tool-verb otk-control-label" title={label()}>
        {label()}
      </span>
      <Show when={activity()?.detail}>
        <span
          class="otk-tool-brief otk-control-label otk-control-grow"
          title={activity()?.detail}
        >
          {activity()?.detail}
        </span>
      </Show>
    </>
  );
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
          <TreeNode
            label={label()}
            outgoing={activity()?.direction === "outgoing" ? true : undefined}
            open={expanded()}
            onOpen={details() ? setExpanded : undefined}
            feedback={failure()
              ? () => (
                <FailureContent failure={failure()!} time={props.failureTime} />
              )
              : undefined}
            header={() => (
              <header class="otk-tool-state otk-control-row">
                <TreeIcon>
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
                </TreeIcon>
                <Show when={activity()?.entity}>
                  {(entity) => (
                    <EntityPill
                      label={entity().label}
                      facts={scopedEntityFacts(session, entity())}
                      onOpen={props.onOpenChild}
                    />
                  )}
                </Show>
                <Show
                  when={details()}
                  fallback={
                    <div class="otk-tool-heading otk-control-grow">
                      {heading()}
                    </div>
                  }
                >
                  <button
                    type="button"
                    class="otk-tool-toggle otk-control-grow"
                    aria-expanded={expanded() ? "true" : "false"}
                    onClick={() => setExpanded(!expanded())}
                  >
                    {heading()}
                  </button>
                </Show>
                <Show when={activity()?.child}>{(ref) => child(ref())}</Show>
              </header>
            )}
            body={details()
              ? () => (
                <TreeItem last>
                  <TreeNode
                    header={() => (
                      <div class="otk-tool-body">
                        <Show when={state()}>
                          {(value) => <p>{value()}</p>}
                        </Show>
                        <Show
                          when={props.recordTime !== undefined ||
                            activity()?.parameters?.length}
                        >
                          <dl class="otk-native-parameters">
                            <Show
                              when={props.recordTime === undefined
                                ? undefined
                                : new Date(props.recordTime)}
                            >
                              {(recorded) => (
                                <>
                                  <dt>Recorded at</dt>
                                  <dd>
                                    <time
                                      class="otk-native-value"
                                      data-record-time=""
                                      datetime={recorded().toISOString()}
                                    >
                                      {recorded().toLocaleString(undefined, {
                                        year: "numeric",
                                        month: "short",
                                        day: "numeric",
                                        hour: "numeric",
                                        minute: "2-digit",
                                        second: "2-digit",
                                        fractionalSecondDigits: 3,
                                        timeZoneName: "short",
                                      })}
                                    </time>
                                  </dd>
                                </>
                              )}
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
                                          onOpen={props.onOpenChild}
                                        />
                                      )}
                                    </Show>
                                  </dd>
                                </>
                              )}
                            </For>
                          </dl>
                        </Show>
                        <Show when={activity()?.body}>
                          {(body) => (
                            <Blocks
                              blocks={body()}
                              conceal={props.prefs.conceal}
                            />
                          )}
                        </Show>
                        <Show when={preview() || reference()}>
                          <NativeSource
                            reference={reference()}
                            preview={preview()}
                            prefs={props.prefs}
                          />
                        </Show>
                      </div>
                    )}
                  />
                </TreeItem>
              )
              : undefined}
          />
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
