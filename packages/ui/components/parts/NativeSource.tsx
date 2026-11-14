// SPDX-License-Identifier: LGPL-3.0-only
import "../tools/ToolFrame.css" with { type: "text" };
import "./NativeSource.css" with { type: "text" };
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
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
  const [loaded, setLoaded] = createSignal<Loaded>();
  let live = true, attempt = 0;
  onCleanup(() => live = false);
  // The transcript owner keeps each result per reference, so a remount or a
  // theme change shows the same outcome without reading again.
  const load = (retry = false) => {
    const ref = props.reference;
    if (!ref || (!retry && loaded())) return;
    if (!read) {
      setLoaded({
        state: "failed",
        failure: failureValue(new Error("Source is unavailable here"), {
          action: "Load source",
          reason: "This view has no source reader",
          recovery: "Open the conversation in its own view",
        }),
      });
      return;
    }
    const current = ++attempt;
    setLoaded({ state: "loading" });
    read(ref, { retry }).then((view) => {
      if (live && current === attempt) {
        setLoaded({ state: "ready", ...sourcePreview(view) });
      }
    }, (error) => {
      if (!live || current !== attempt) return;
      setLoaded({
        state: "failed",
        failure: failureValue(error, { action: "Load source" }),
      });
    });
  };
  const toggle = () => setOpen(!open());
  // An explicit choice or the category default can open the fold; either reads.
  createEffect(open, (value) => {
    if (value) load();
  });
  const shown = () => {
    if (!props.reference) {
      return props.preview && { state: "ready" as const, ...props.preview };
    }
    return loaded();
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
                      run: () => load(true),
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
