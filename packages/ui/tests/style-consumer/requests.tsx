// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, Show } from "solid-js";
import ComposerNotice, {
  ComposerNoticeRow,
} from "../../components/ComposerNotice.tsx";
import OperationFeedback from "../../components/OperationFeedback.tsx";
import FieldFeedback from "../../components/FieldFeedback.tsx";
import PaneState from "../../components/PaneState.tsx";
import "./requests.css" with { type: "text" };

export default function Requests() {
  const [mode, setMode] = createSignal<"clear" | "pending" | "error">(
    "pending",
  );
  let field!: HTMLInputElement;
  styleTest.feedback = (value) => {
    setMode(value);
  };
  const fieldFeedback = () =>
    mode() === "clear" ? undefined : mode() === "error"
      ? {
        kind: "error" as const,
        text: "Could not create this task. Try again",
        field: "taskName",
      }
      : { kind: "pending" as const, text: "Creating task" };
  return (
    <div class="request-feedback-scene">
      <section
        class="request-feedback-form"
        aria-label="Task feedback example"
        data-feedback-region="form"
      >
        <label>
          Name<input
            ref={field}
            value="perf"
            readonly={mode() === "pending"}
            aria-describedby="task-feedback"
            aria-invalid={mode() === "error" ? "true" : undefined}
          />
        </label>
        <FieldFeedback id="task-feedback" feedback={fieldFeedback()} />
        <FieldFeedback action />
        <div class="request-feedback-action">
          <Show
            when={mode() !== "pending"}
            fallback={<span role="status">Creating task</span>}
          >
            <button
              type="button"
              onClick={() => {
                setMode("pending");
                field.focus();
              }}
            >
              Save task
            </button>
          </Show>
        </div>
      </section>
      <section
        aria-label="Composer feedback example"
        data-feedback-region="notice"
      >
        <ComposerNotice>
          <OperationFeedback
            feedback={mode() === "error"
              ? { kind: "error", text: "Could not send this prompt. Try again" }
              : { kind: "pending", text: "Sending prompt" }}
          />
          <ComposerNoticeRow
            icon={<span aria-hidden="true">↶</span>}
            trailing={
              <button
                type="button"
                onClick={() => setMode("pending")}
              >
                Restore
              </button>
            }
          >
            2 prompts rolled back
          </ComposerNoticeRow>
        </ComposerNotice>
      </section>
      <section
        class="request-feedback-pane"
        aria-label="Conversation feedback example"
        data-feedback-region="pane"
      >
        <PaneState
          feedback={mode() === "error"
            ? {
              kind: "error",
              text: "Could not load this conversation",
              action: { label: "Try again", run: () => setMode("pending") },
            }
            : { kind: "pending", text: "Loading messages" }}
        />
      </section>
    </div>
  );
}
