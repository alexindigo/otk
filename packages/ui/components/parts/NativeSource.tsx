// SPDX-License-Identifier: LGPL-3.0-only
import "../tools/ToolFrame.css" with { type: "text" };
import CodeBlock from "../CodeBlock.tsx";
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
  transcriptDisclosureIdentity,
  useNativeSource,
} from "../../features/transcript-context.tsx";
import { TreeItem, TreeNode } from "../Tree.tsx";
import { WorkLogIcon } from "../ChromeIcons.tsx";
import { sourcePreview } from "./native-source-preview.ts";
import Disclosure, { useDisclosure } from "../Disclosure.tsx";

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
  const identify = transcriptDisclosureIdentity();
  const hasContent = () => !!(props.reference || props.preview);
  const input = { category: "source" as const, prefs: () => props.prefs };
  const state = useDisclosure("source", identify, input);
  const open = () => hasContent() && state.open();
  const read = useNativeSource();
  const resource = createMemo(() =>
    open() && props.reference ? read?.(props.reference) : undefined
  );
  const [revision, setRevision] = createSignal(0);
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
  // Only the feature-authored missing-reader feedback is memoized. Ready and
  // pending Source values remain borrowed directly from the resource owner.
  const unavailable = createMemo(() => {
    if (read || !props.reference) return;
    return failureValue(new Error("Source is unavailable here"), {
      actionLabel: "Load source",
      reason: "This view has no source reader",
      recovery: "Open the conversation in its own view",
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
        failure: unavailable() ?? "",
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
      <Disclosure
        kind="source"
        identity={identify()}
        input={input}
        variant="label"
        class="otk-tool-toggle"
        lead={() => <WorkLogIcon />}
        label="Source"
        hasContent={hasContent}
        layout={({ trigger, region, open, frame }) => (
          <TreeNode
            class="otk-tool-row"
            ref={frame}
            trigger={{ variant: "span", element: trigger, hasBox: hasContent }}
            bodyVisible={open()}
            region={region}
          />
        )}
      >
        {() => (
          <TreeItem last>
            <TreeNode
              header={() => (
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
                            action: resource()
                              ? {
                                label: "Retry",
                                run: () => resource()?.retry(),
                              }
                              : undefined,
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
                        <CodeBlock
                          source={{ kind: "output", text: value().text }}
                          textClass="otk-native-preview"
                        />
                      </>
                    )}
                  </Show>
                </div>
              )}
            />
          </TreeItem>
        )}
      </Disclosure>
    </section>
  );
}
