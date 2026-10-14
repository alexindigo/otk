// SPDX-License-Identifier: LGPL-3.0-only
import "./Prompt.css" with { type: "text" };
import { createSignal, For, onSettled, Show } from "solid-js";
import {
  type DraftChange,
  editDraft,
  emptyDraft,
  serialize,
} from "./prompt/model.ts";
import { createCompletion } from "./prompt/Completion.tsx";
import { useUiRegistries } from "../registries/context.tsx";
import type { PromptContext, PromptProps } from "../registries/prompt.ts";

/** Input and submission lifetime; concrete prompt concepts are injected features. */
export default function Prompt(props: PromptProps): import("solid-js").Element {
  const [pending, setPending] = createSignal(false),
    [error, setError] = createSignal(""),
    [armed, setArmed] = createSignal(false),
    [caret, setCaret] = createSignal(0);
  let active = true, input!: HTMLTextAreaElement;
  let deadline = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const change = (update: DraftChange, caret?: number) => {
    const draft = props.onChange(update);
    if (caret !== undefined && active) {
      input.value = draft.input;
      input.setSelectionRange(caret, caret);
      setCaret(caret);
    }
    return draft;
  };
  const ctx: PromptContext = {
    props,
    change,
    caret,
    active: () => active,
    selection: () => ({ start: input.selectionStart, end: input.selectionEnd }),
    focus: () => input.focus(),
    fail: (error) => {
      if (active) setError((error as Error).message);
    },
    acceptFiles: async (files) => {
      for (const feature of features) await feature.drop?.(files);
    },
  };
  const features = useUiRegistries().prompt.create(ctx);
  const completion = createCompletion(ctx, features);
  const canSubmit = () =>
    props.connected &&
    (features.map((feature) => feature.enabled?.()).find((value) =>
      value !== undefined
    ) ?? props.promptEnabled !== false);
  const submit = async () => {
    const draft = change((current) => current);
    for (const feature of features) {
      if (await feature.beforeSubmit?.(draft)) return;
    }
    if (
      !draft.input.trim() || !canSubmit() || pending() ||
      draft.chips.some((chip) => chip.pending || chip.error)
    ) return;
    setPending(true);
    setError("");
    try {
      const parts = serialize(draft);
      let handled = false;
      for (const feature of features) {
        if (await feature.submit?.(draft, parts)) {
          handled = true;
          break;
        }
      }
      if (!handled) await props.onSubmit(parts, draft.mode);
      if (active) {
        for (const feature of features) feature.submitted?.();
        change((current) => current === draft ? emptyDraft() : current);
      }
    } catch (error) {
      if (active && change((current) => current) === draft) ctx.fail(error);
    } finally {
      if (active) setPending(false);
    }
  };
  const escape = async (event: KeyboardEvent) => {
    if (
      event.key !== "Escape" || event.defaultPrevented || props.value.editor ||
      !props.connected || props.promptEnabled === false
    ) return;
    event.preventDefault();
    if (Date.now() < deadline) {
      deadline = 0;
      clearTimeout(timer);
      setArmed(false);
      try {
        await props.onAbort();
      } catch (error) {
        ctx.fail(error);
      }
    } else {
      deadline = Date.now() + 5000;
      setArmed(true);
      timer = setTimeout(() => {
        deadline = 0;
        setArmed(false);
      }, 5000);
    }
  };
  onSettled(() => {
    document.addEventListener("keydown", escape);
    return () => {
      active = false;
      document.removeEventListener("keydown", escape);
      clearTimeout(timer);
    };
  });
  return (
    <form
      class="otk-prompt"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void ctx.acceptFiles(Array.from(event.dataTransfer?.files || []));
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label for="otk-prompt-input">
        {features.find((feature) => feature.label)?.label?.() ?? "Prompt"}
      </label>
      {completion.beforeInput?.()}
      <For each={features}>{(feature) => feature.beforeInput?.()}</For>
      <textarea
        ref={(element) => {
          input = element;
        }}
        id="otk-prompt-input"
        name="prompt"
        placeholder={features.find((feature) => feature.placeholder)
          ?.placeholder?.() ?? "Message the agent…"}
        value={props.value.input}
        onPaste={(event) => {
          for (const feature of features) {
            if (feature.paste) {
              void feature.paste(event);
              break;
            }
          }
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onClick={(event) => setCaret(event.currentTarget.selectionStart)}
        onInput={(event) => {
          setCaret(event.currentTarget.selectionStart);
          const value = event.currentTarget.value;
          change((current) => editDraft(current, value));
        }}
        onKeyDown={(event) => {
          if (completion.key?.(event)) return;
          for (const feature of features) if (feature.key?.(event)) return;
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div class="otk-prompt-actions">
        <For each={features}>{(feature) => feature.actions?.()}</For>
        <span class="otk-muted">
          {armed()
            ? "esc again to interrupt"
            : "Enter to send · Shift+Enter for newline · Esc twice to interrupt"}
        </span>
        <button
          type="submit"
          disabled={pending() ||
            props.value.chips.some((chip) => chip.pending || chip.error) ||
            !canSubmit() || !props.value.input.trim()}
        >
          Send
        </button>
      </div>
      <Show when={error()}>
        <p class="otk-error" role="alert">{error()}</p>
      </Show>
      <For each={features}>{(feature) => feature.overlay?.()}</For>
    </form>
  );
}
