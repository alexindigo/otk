// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, Show } from "solid-js";
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import TaskMarker from "./TaskMarker.tsx";
import "./ChoiceFrame.css" with { type: "text" };

/** Owns the same label/detail, selection and accessory frame for every choice. */
export function ChoiceFrame(props: {
  label: string;
  description?: string;
  editor?(): Element;
  accessory?(): Element;
  selected: boolean;
  multiple?: boolean;
  onPick(event: MouseEvent): void;
  row?(element: HTMLElement): void;
}) {
  const state = () => ({
    class: "otk-choice-frame",
    kind: "pressed" as const,
    selected: props.selected,
  });
  const marker = () =>
    props.multiple
      ? (
        <span aria-hidden="true">
          <TaskMarker done={props.selected} />
        </span>
      )
      : undefined;
  const content = () => (
    <span class="otk-choice-body">
      <span class="otk-control-label otk-choice-label" title={props.label}>
        {props.label}
      </span>
      <Show
        when={props.editor}
        fallback={
          <Show when={props.description}>
            <span
              class="otk-muted otk-control-label otk-choice-detail"
              title={props.description}
            >
              {props.description}
            </span>
          </Show>
        }
      >
        <span class="otk-choice-detail">{props.editor?.()}</span>
      </Show>
    </span>
  );
  return (
    <div class="otk-choice-row">
      <Show
        when={props.editor}
        fallback={
          <button
            type="button"
            data-question-row
            data-otk-selection="vertical"
            ref={(element) => props.row?.(element)}
            {...selection(state())}
            onClick={props.onPick}
          >
            <SelectionContent class="otk-choice-content" leading={marker()}>
              {content()}
            </SelectionContent>
          </button>
        }
      >
        <div
          data-question-row
          data-otk-selection="vertical"
          role="button"
          tabindex="-1"
          ref={(element) => props.row?.(element)}
          {...selection(state())}
          onClick={props.onPick}
        >
          <SelectionContent class="otk-choice-content" leading={marker()}>
            {content()}
          </SelectionContent>
        </div>
      </Show>
      <Show when={props.accessory}>
        <span class="otk-choice-accessory">{props.accessory?.()}</span>
      </Show>
    </div>
  );
}
