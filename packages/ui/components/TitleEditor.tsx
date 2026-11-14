// SPDX-License-Identifier: LGPL-3.0-only
import "./TitleEditor.css" with { type: "text" };
import {
  createSignal,
  createUniqueId,
  type Element,
  onSettled,
  Show,
} from "solid-js";
import type { SessionRename } from "@otk/client";
import { errorFeedback } from "@otk/client";
import { MAX_SESSION_TITLE } from "@otk/protocol";
import FieldFeedback from "./FieldFeedback.tsx";

/** Native input only. The injected owner owns editing, admission and failures. */
export function TitleFeedback(
  props: { owner: SessionRename; id: string },
): Element {
  return (
    <FieldFeedback
      id={props.id}
      feedback={props.owner.state.pending
        ? { kind: "pending", text: "Renaming session…" }
        : props.owner.state.error
        ? errorFeedback(props.owner.state.error)
        : undefined}
    />
  );
}
export default function TitleEditor(
  props: { owner: SessionRename; feedbackID?: string },
) {
  const [title, setTitle] = createSignal(props.owner.state.editing!.title);
  const errorID = props.feedbackID ?? createUniqueId();
  let input!: HTMLInputElement;
  onSettled(() => {
    input.focus();
    input.select();
  });
  return (
    <span
      class="otk-title-editor"
      data-origin={props.owner.state.editing?.origin}
      onClick={(event) => event.stopPropagation()}
      onDblClick={(event) => event.stopPropagation()}
    >
      <input
        ref={(element) => input = element}
        aria-label="Rename session"
        aria-describedby={errorID}
        aria-invalid={props.owner.state.error ? "true" : undefined}
        aria-busy={props.owner.state.pending ? "true" : undefined}
        maxlength={MAX_SESSION_TITLE}
        value={title()}
        readonly={props.owner.state.pending}
        onInput={(event) => setTitle(event.currentTarget.value)}
        onBlur={() => void props.owner.commit(title())}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            props.owner.cancel();
          } else if (event.key === "Enter") {
            event.preventDefault();
            void props.owner.commit(title());
          }
        }}
      />
      <Show when={!props.feedbackID}>
        <TitleFeedback owner={props.owner} id={errorID} />
      </Show>
    </span>
  );
}
