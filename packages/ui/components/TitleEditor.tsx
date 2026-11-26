// SPDX-License-Identifier: LGPL-3.0-only
import "./TitleEditor.css" with { type: "text" };
import { createUniqueId, type Element, onSettled, Show } from "solid-js";
import type { InlineRenameField } from "@otk/client";
import { errorFeedback } from "@otk/client";
import FieldFeedback from "./FieldFeedback.tsx";

type TitleOwner = InlineRenameField<{ title: string; origin?: string }>;

/** Native input only. The injected owner owns editing, admission and failures. */
export function TitleFeedback(
  props: {
    owner: TitleOwner;
    id: string;
    pendingText: string;
    expanded?: boolean;
  },
): Element {
  return (
    <FieldFeedback
      id={props.id}
      expanded={props.expanded}
      validation={props.owner.state.invalid}
      feedback={props.owner.state.pending
        ? { kind: "pending", text: props.pendingText }
        : props.owner.state.error
        ? errorFeedback(props.owner.state.error)
        : undefined}
    />
  );
}
export default function TitleEditor(
  props: {
    owner: TitleOwner;
    label: string;
    pendingText: string;
    maxLength?: number;
    feedbackID?: string;
  },
) {
  const title = () =>
    props.owner.state.input ?? props.owner.state.editing!.title;
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
        aria-label={props.label}
        aria-describedby={errorID}
        aria-invalid={props.owner.state.error || props.owner.state.invalid
          ? "true"
          : undefined}
        aria-busy={props.owner.state.pending ? "true" : undefined}
        maxlength={props.maxLength}
        value={title()}
        readonly={props.owner.state.pending}
        onInput={(event) => props.owner.edit(event.currentTarget.value)}
        onBlur={() => {
          const editing = props.owner.state.editing;
          // Keyed moves can natively blur a connected editor. Let rendering and
          // its retained-focus owner settle before treating that as departure.
          onSettled(() =>
            queueMicrotask(() => {
              if (
                input.isConnected && document.activeElement !== input &&
                props.owner.state.editing === editing
              ) void props.owner.commit(title(), "blur");
            })
          );
        }}
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
        <TitleFeedback
          owner={props.owner}
          id={errorID}
          pendingText={props.pendingText}
        />
      </Show>
    </span>
  );
}
