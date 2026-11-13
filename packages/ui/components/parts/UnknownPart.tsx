// SPDX-License-Identifier: LGPL-3.0-only
import "../tools/ToolFrame.css" with { type: "text" };
import "./UnknownPart.css" with { type: "text" };
import { For, Show } from "solid-js";
import type { ChildRef } from "@otk/protocol";
import type { PartProps, PartRegistry } from "../../registries/renderers.ts";
import { retainedDisclosure } from "../../features/transcript-context.tsx";
import Blocks from "../Blocks.tsx";
import { ChevronIcon } from "../ChromeIcons.tsx";
import Icon from "../Icon.tsx";
import { unknownPartPresentation, unknownPartPreview } from "./unknown-part.ts";
import NativeSource from "./NativeSource.tsx";

export function UnknownPart(props: PartProps): import("solid-js").Element {
  const activity = () =>
    props.part.kind === "external" ? props.part.activity : undefined;
  const [expanded, setExpanded] = retainedDisclosure(
    "activity",
    () => activity()?.category ?? "record",
    () => props.prefs,
  );
  const preview = () => unknownPartPreview(props.part);
  const name = () =>
    props.part.kind === "external"
      ? props.part.name
      : props.part.kind === "unknown"
      ? props.part.label || props.part.kind
      : props.part.kind;
  const details = () =>
    !!(activity()?.state || activity()?.body?.length ||
      activity()?.parameters?.length || preview());
  const label = () => activity()?.title ?? `Unsupported part: ${name()}`;
  // A state already presented by the heading or a parameter is not repeated.
  const state = () => {
    const value = activity()?.state?.label;
    return value && value !== label() &&
        !activity()?.parameters?.some((p) => p.value === value)
      ? value
      : undefined;
  };
  const child = (ref: ChildRef, value?: boolean) => (
    <button
      type="button"
      class={value ? "otk-native-value" : undefined}
      onClick={() => props.onOpenChild(ref.sessionID)}
    >
      {ref.label}
    </button>
  );
  const heading = () => (
    <>
      <Show when={details()}>
        <span class="otk-tool-icon otk-native-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
      </Show>
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
    <section
      class={["otk-tool-line otk-native-record", {
        "is-error": activity()?.tone === "error",
        "is-open": !!expanded(),
      }]}
      data-native-record={name()}
    >
      <header class="otk-tool-state otk-control-row">
        <Show
          when={details()}
          fallback={
            <div class="otk-tool-heading otk-control-grow">{heading()}</div>
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
      <Show when={expanded() && details()}>
        <div class="otk-tool-body">
          <Show when={state()}>{(value) => <p>{value()}</p>}</Show>
          <Show when={activity()?.parameters?.length}>
            <dl class="otk-native-parameters">
              <For
                each={activity()?.parameters}
                keyed={(parameter) => parameter.key}
              >
                {(parameter) => (
                  <>
                    <dt>{parameter().label}</dt>
                    <dd>
                      <Show
                        when={parameter().child}
                        fallback={
                          <span class="otk-native-value">
                            {parameter().value}
                          </span>
                        }
                      >
                        {(ref) => child(ref(), true)}
                      </Show>
                    </dd>
                  </>
                )}
              </For>
            </dl>
          </Show>
          <Show when={activity()?.body}>
            {(body) => <Blocks blocks={body()} conceal={props.prefs.conceal} />}
          </Show>
          <Show when={preview()}>
            {(value) => <NativeSource preview={value()} prefs={props.prefs} />}
          </Show>
        </div>
      </Show>
    </section>
  );
}
export function registerUnknownPart(parts: PartRegistry): void {
  parts.fallback(UnknownPart, unknownPartPresentation);
}
