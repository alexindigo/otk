// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { FormDraft } from "@otk/client";
import type { FormField as Field, FormValue } from "@otk/protocol";
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import ContentTextarea from "./ContentTextarea.tsx";
import TaskMarker from "./TaskMarker.tsx";
import { CloseIcon } from "./ChromeIcons.tsx";
import "./FormField.css" with { type: "text" };
/** The same native toggle as preference controls, with explicit unanswered state. */
function FormToggle(
  props: { label: string; value?: boolean; onChange(value: boolean): void },
) {
  return (
    <label class="otk-form-toggle">
      <input
        type="checkbox"
        role="switch"
        aria-label={props.label}
        checked={props.value === true}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span>
        {props.value === undefined
          ? "Not answered"
          : props.value
          ? "On"
          : "Off"}
      </span>
    </label>
  );
}
/** One value row owns its label, selection marker and optional square remove slot. */
export function FormChoice(props: {
  label: string;
  description?: string;
  selected: boolean;
  multiple?: boolean;
  onPick(): void;
  onRemove?(): void;
  row?(element: HTMLElement): void;
}) {
  return (
    <div class="otk-form-choice-row">
      <button
        type="button"
        data-question-row
        data-otk-selection="vertical"
        ref={props.row}
        {...selection({
          class: "otk-question-row",
          kind: "pressed",
          selected: props.selected,
        })}
        onClick={props.onPick}
      >
        <SelectionContent
          class="otk-question-content"
          leading={props.multiple
            ? (
              <span aria-hidden="true">
                <TaskMarker done={props.selected} />
              </span>
            )
            : undefined}
        >
          <span class="otk-control-label" title={props.label}>
            {props.label}
          </span>
          <Show when={props.description}>
            <span class="otk-muted otk-control-label" title={props.description}>
              {props.description}
            </span>
          </Show>
        </SelectionContent>
      </button>
      <Show when={props.onRemove}>
        <button
          type="button"
          class="otk-icon-button"
          aria-label={`Remove ${props.label}`}
          title={`Remove ${props.label}`}
          onClick={() => props.onRemove?.()}
        >
          <CloseIcon />
        </button>
      </Show>
    </div>
  );
}
/** One choice renderer for legacy questions and typed form fields. */
export function FormChoices(props: {
  options: readonly { value: string; label: string; description?: string }[];
  selected(value: string): boolean;
  onPick(index: number): void;
  multiple?: boolean;
  custom?: boolean;
  own: string;
  ownChosen?: boolean;
  onOwn(): void;
  onText(text: string): void;
  row?(element: HTMLElement, index: number): void;
  input?(element: HTMLTextAreaElement): void;
}) {
  let input: HTMLTextAreaElement | undefined;
  return (
    <div class="otk-question-options">
      <For each={props.options} keyed={false}>
        {(option, index) => (
          <FormChoice
            label={option().label}
            description={option().description}
            selected={props.selected(option().value)}
            multiple={props.multiple}
            row={(el) => props.row?.(el, index)}
            onPick={() => props.onPick(index)}
          />
        )}
      </For>
      <Show when={props.custom}>
        <div
          data-question-row
          data-otk-selection="vertical"
          role="button"
          tabindex="-1"
          ref={(el) => props.row?.(el, props.options.length)}
          {...selection({
            class: "otk-question-row",
            kind: "pressed",
            selected: !!props.ownChosen,
          })}
          onClick={(event) => {
            if (event.target !== input) {
              props.onOwn();
              input?.focus();
            }
          }}
        >
          <SelectionContent
            class="otk-question-content"
            leading={props.multiple
              ? (
                <span aria-hidden="true">
                  <TaskMarker done={!!props.ownChosen} />
                </span>
              )
              : undefined}
          >
            <span class="otk-control-label" title="Type your own answer">
              Type your own answer
            </span>
            <ContentTextarea
              ref={(el) => {
                input = el;
                props.input?.(el);
              }}
              class="otk-question-own"
              aria-label="Custom answer"
              name="question-answer"
              rows={1}
              placeholder="Your answer..."
              value={props.own}
              onInput={(event) => props.onText(event.currentTarget.value)}
            />
          </SelectionContent>
        </div>
      </Show>
    </div>
  );
}
export default function FormField(
  props: {
    field: Field;
    draft: FormDraft;
    value?: FormValue;
    onValue(value?: FormValue): void;
    onText(text: string): void;
    onChoice(value: string): void;
    onCustomText(text: string): void;
    onAddCustom(): void;
  },
) {
  const field = () => props.field;
  const custom = () => props.draft.custom ?? "";
  const values = () => Array.isArray(props.value) ? props.value : [];
  const stringField = () =>
    field().type === "string"
      ? field() as Extract<Field, { type: "string" }>
      : undefined;
  const choices = () =>
    field().type === "multiselect"
      ? (field() as Extract<Field, { type: "multiselect" }>).options
      : stringField()?.options;
  const choose = (index: number) => {
    const options = choices(), value = options?.[index]?.value;
    if (value === undefined) return;
    props.onChoice(value);
  };
  const external = () =>
    field().type === "external"
      ? field() as Extract<Field, { type: "external" }>
      : undefined;
  const safeUrl = () => {
    const url = external()?.url;
    try {
      const parsed = new URL(url ?? "");
      return ["https:", "http:"].includes(parsed.protocol)
        ? parsed.href
        : undefined;
    } catch {
      return;
    }
  };
  return (
    <div class="otk-form-control">
      <Show when={choices()}>
        {(options) => (
          <>
            <FormChoices
              options={options()}
              multiple={field().type === "multiselect"}
              selected={(value) =>
                field().type === "multiselect"
                  ? values().includes(value)
                  : props.value === value}
              onPick={choose}
              custom={!!stringField()?.custom}
              own={props.draft.customValue ??
                (typeof props.value === "string" &&
                    !choices()?.some((x) => x.value === props.value)
                  ? props.value
                  : "")}
              ownChosen={typeof props.value === "string" &&
                !choices()?.some((x) => x.value === props.value)}
              onOwn={() => props.onText(props.draft.customValue ?? "")}
              onText={props.onText}
            />
            <Show
              when={field().type === "multiselect" &&
                (field() as Extract<Field, { type: "multiselect" }>).custom}
            >
              <div class="otk-form-custom">
                <input
                  aria-label="Custom value"
                  placeholder="Add a value"
                  value={custom()}
                  onInput={(e) => props.onCustomText(e.currentTarget.value)}
                />
                <Show when={custom().length}>
                  <button
                    type="button"
                    class="otk-pill"
                    onClick={() => props.onAddCustom()}
                  >
                    Add value
                  </button>
                </Show>
              </div>
              <For
                each={values().filter((v) =>
                  !choices()?.some((o) => o.value === v)
                )}
                keyed={false}
              >
                {(value) => (
                  <FormChoice
                    label={value()}
                    selected
                    multiple
                    onPick={() => props.onChoice(value())}
                    onRemove={() => props.onChoice(value())}
                  />
                )}
              </For>
            </Show>
          </>
        )}
      </Show>
      <Show when={field().type === "string" && !choices()}>
        <input
          aria-label={field().title || field().key}
          type={stringField()?.format === "email"
            ? "email"
            : stringField()?.format === "uri"
            ? "url"
            : "text"}
          placeholder={stringField()?.placeholder ??
            (stringField()?.format === "date-time"
              ? "2026-11-09T12:30:00-08:00"
              : stringField()?.format === "date"
              ? "YYYY-MM-DD"
              : undefined)}
          value={typeof props.value === "string" ? props.value : ""}
          onInput={(e) => props.onText(e.currentTarget.value)}
        />
      </Show>
      <Show when={field().type === "number" || field().type === "integer"}>
        <input
          type="text"
          inputmode={field().type === "integer" ? "numeric" : "decimal"}
          aria-label={field().title || field().key}
          value={props.draft.text ??
            (typeof props.value === "number" ? String(props.value) : "")}
          onInput={(e) => props.onText(e.currentTarget.value)}
        />
      </Show>
      <Show when={field().type === "boolean"}>
        <div class="otk-form-boolean">
          <FormToggle
            label={field().title || field().key}
            value={typeof props.value === "boolean" ? props.value : undefined}
            onChange={props.onValue}
          />
          <Show
            when={props.value !== undefined &&
              !(field() as { required?: boolean }).required}
          >
            <button
              type="button"
              class="otk-pill"
              onClick={() => props.onValue(undefined)}
            >
              Clear answer
            </button>
          </Show>
        </div>
      </Show>
      <Show when={external()}>
        <div class="otk-form-external">
          <Show
            when={safeUrl()}
            fallback={<p>This external address cannot be opened safely.</p>}
          >
            {(url) => (
              <a
                class="otk-pill"
                href={url()}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open external step
              </a>
            )}
          </Show>
          <FormToggle
            label="I completed this step"
            value={props.value === true}
            onChange={(value) => props.onValue(value ? true : undefined)}
          />
        </div>
      </Show>
    </div>
  );
}
