// SPDX-License-Identifier: LGPL-3.0-only
import "../tools/ToolFrame.css" with { type: "text" };
import "./NativeSource.css" with { type: "text" };
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import type { Preferences } from "@otk/protocol";
import { errorFeedback, type FailureValue, failureValue } from "@otk/client";
import FeedbackStatus from "../FeedbackStatus.tsx";
import {
  retainedDisclosure,
  useNativeSource,
} from "../../features/transcript-context.tsx";
import { ChevronIcon } from "../ChromeIcons.tsx";
import { sourcePreview } from "./native-source-preview.ts";

type Loaded =
  | { state: "loading" }
  | { state: "ready"; text: string; bytes: number; truncated: boolean }
  | { state: "failed"; failure: FailureValue };

/** Source inspection has its own identity-scoped choice and category default.
 * A plugin reference is read only while the fold is open. */
export default function NativeSource(props: {
  reference?: string;
  preview?: { text: string; bytes: number; truncated: boolean };
  prefs: Preferences;
}): import("solid-js").Element {
  const [open, setOpen] = retainedDisclosure(
    "source",
    "source",
    () => props.prefs,
  );
  const read = useNativeSource();
  const resource = createMemo(() =>
    open() && props.reference ? read?.(props.reference) : undefined
  );
  const [revision, setRevision] = createSignal(0);
  const toggle = () => setOpen(!open());
  // An explicit choice or the category default can open the fold; either reads.
  createEffect(() => [open(), resource()] as const, ([expanded, owner]) => {
    if (!expanded || !owner) return;
    const off = owner.subscribe(() => setRevision((v) => v + 1));
    const release = owner.retain();
    onCleanup(() => {
      off();
      release();
    });
  });
  const shown = (): Loaded | undefined => {
    revision();
    if (!props.reference) {
      return props.preview && { state: "ready" as const, ...props.preview };
    }
    const value = resource()?.state;
    if (!value) {
      return {
        state: "failed",
        failure: failureValue(new Error("Source is unavailable here"), {
          action: "Load source",
          reason: "This view has no source reader",
          recovery: "Open the conversation in its own view",
        }),
      };
    }
    return value.state === "ready"
      ? { state: "ready", ...sourcePreview(value.value) }
      : value.state === "failed"
      ? value
      : { state: "loading" };
  };
  return (
    <section class={["otk-tool-line otk-native-source", { "is-open": open() }]}>
      <button
        type="button"
        class="otk-tool-toggle"
        aria-expanded={open() ? "true" : "false"}
        onClick={toggle}
      >
        <span class="otk-tool-icon" aria-hidden="true">
          <ChevronIcon />
        </span>
        <span class="otk-control-label">Source</span>
      </button>
      <Show when={open()}>
        <div
          class="otk-tool-body"
          aria-busy={shown()?.state === "loading" ? "true" : "false"}
        >
          <Show when={shown()?.state === "loading"}>
            <small class="otk-muted">Loading source</small>
          </Show>
          <Show
            when={(() => {
              const value = shown();
              return value?.state === "failed" ? value : undefined;
            })()}
          >
            {(value) => (
              <FeedbackStatus
                feedback={(() => {
                  const feedback = errorFeedback(value().failure);
                  return feedback && {
                    ...feedback,
                    action: {
                      label: "Retry",
                      run: () => resource()?.retry(),
                    },
                  };
                })()}
              />
            )}
          </Show>
          <Show
            when={(() => {
              const value = shown();
              return value?.state === "ready" ? value : undefined;
            })()}
          >
            {(value) => (
              <>
                <small class="otk-muted">
                  {value().bytes}{" "}
                  bytes{value().truncated ? " - Preview truncated" : ""}
                </small>
                <pre class="otk-native-preview">{value().text}</pre>
              </>
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
}
