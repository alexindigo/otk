// SPDX-License-Identifier: LGPL-3.0-only
import "./Prompt.css" with { type: "text" };
import { createEffect, createSignal, For, onSettled, Show } from "solid-js";
import {
  type DraftChange,
  editDraft,
  hasDraftContent,
  serialize,
} from "./prompt/model.ts";
import { createCompletion } from "./prompt/Completion.tsx";
import { useUiRegistries } from "../registries/context.tsx";
import type { PromptContext, PromptProps } from "../registries/prompt.ts";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import { createKeyboard } from "../keyboard/dispatcher.ts";
import { useSessionPorts } from "../registries/session.tsx";
import { SendIcon } from "./ChromeIcons.tsx";
import { clearDraft, effectiveSelection } from "@otk/client";
import type { PromptChoices } from "../registries/prompt.ts";
import { ModelLabel, selectionLabel } from "./prompt/labels.tsx";

/** Input and submission lifetime; concrete prompt concepts are injected features. */
export default function Prompt(props: PromptProps): import("solid-js").Element {
  const [pending, setPending] = createSignal(false),
    [error, setError] = createSignal(""),
    [armed, setArmed] = createSignal(false),
    [caret, setCaret] = createSignal(0);
  let active = true, input!: HTMLTextAreaElement;
  // Capture the session-bound writer: a late send/upload must never edit a
  // replacement session, and must still finish updating its retained draft.
  const write = props.onChange;
  let deadline = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const ports = useCommandPorts();
  const keyboard = ports.keyboard ??
    createKeyboard(ports.commands, (error) => ctx.fail(error));
  const releases: (() => void)[] = [];
  const change = (update: DraftChange, caret?: number) => {
    const draft = write(update);
    if (caret !== undefined && active) {
      input.value = draft.input;
      input.setSelectionRange(caret, caret);
      setCaret(caret);
    }
    return draft;
  };
  const ctx: PromptContext = {
    ...useSessionPorts(),
    commands: ports.commands,
    keyboard,
    own: (release) => releases.push(release),
    props,
    change,
    caret,
    active: () => active,
    selection: () => ({ start: input.selectionStart, end: input.selectionEnd }),
    focus: () => input.focus(),
    focused: () =>
      !props.suspended && document.activeElement === input &&
      !props.value.editor,
    nextSelection: (draft = props.value) =>
      features.find((feature) => feature.selection)?.selection?.(draft) ??
        effectiveSelection(draft, { context: props.context, agents: [] }),
    ready: async () => {
      await Promise.all(features.map((feature) => feature.ready?.()));
    },
    fail: (error) => {
      if (active) setError((error as Error).message);
    },
    acceptFiles: async (files) => {
      for (const feature of features) await feature.drop?.(files);
    },
  };
  const features = useUiRegistries().prompt.create(ctx);
  const completion = createCompletion(ctx, features);
  // The input owns its focus port. Resume only when the replacing surface has
  // released focus, preserving a reader's newer focus elsewhere in the shell.
  createEffect(() => props.suspended, (suspended, previous) => {
    if (previous && !suspended && document.activeElement === document.body) {
      ctx.focus();
    }
  });
  const canSubmit = () =>
    !props.suspended && props.connected &&
    (features.map((feature) => feature.enabled?.()).find((value) =>
      value !== undefined
    ) ?? ctx.supports("prompt"));
  const submit = async () => {
    if (!canSubmit()) return;
    await ctx.ready();
    if (!active || !canSubmit()) return;
    let draft = change((current) => current);
    for (const feature of features) {
      if (await feature.beforeSubmit?.(draft)) return;
    }
    draft = change((current) => current);
    if (
      !active || !hasDraftContent(draft) || !canSubmit() || pending() ||
      draft.chips.some((chip) => chip.pending || chip.error)
    ) return;
    setPending(true);
    setError("");
    try {
      const parts = serialize(draft);
      const effective = ctx.nextSelection(draft);
      const selection = effective.input;
      let handled = false;
      for (const feature of features) {
        if (await feature.submit?.(draft, parts, selection)) {
          handled = true;
          break;
        }
      }
      if (!handled) await send({ parts, mode: draft.mode, selection });
      change((current) => current === draft ? clearDraft(current) : current);
      for (const feature of features) {
        await feature.submitted?.(draft, selection, handled);
      }
    } catch (error) {
      if (active && change((current) => current) === draft) ctx.fail(error);
    } finally {
      if (active) setPending(false);
    }
  };
  const send = ownedCommand(ports, {
    id: "prompt.send",
    title: "Send prompt",
    category: "Prompt",
    hidden: true,
    enabled: canSubmit,
    run: (
      _ctx,
      args: {
        parts: import("@otk/protocol").PromptPart[];
        mode: PromptProps["value"]["mode"];
        selection: PromptChoices;
      },
    ) => props.onSubmit(args.parts, args.mode, args.selection),
  });
  const submitCommand = ownedCommand(ports, {
    id: "prompt.submit",
    title: "Send prompt",
    category: "Prompt",
    hidden: true,
    enabled: canSubmit,
    run: submit,
  });
  ownedCommand(ports, {
    id: "prompt.newline",
    title: "Insert newline",
    category: "Prompt",
    hidden: true,
    run: () => {
      const { start, end } = ctx.selection();
      change((current) =>
        editDraft(
          current,
          current.input.slice(0, start) + "\n" + current.input.slice(end),
        ), start + 1);
    },
  });
  ownedCommand(ports, {
    id: "session.interrupt",
    title: "Interrupt session",
    category: "Session",
    enabled: () =>
      !props.suspended && props.connected && ctx.supports("prompt") &&
      props.busy !== false,
    run: async (_context, args?: { confirm?: boolean }) => {
      if (!args?.confirm) return await props.onAbort();
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
    },
  });
  ownedCommand(ports, {
    id: "session.escape.reset",
    title: "Reset interrupt sequence",
    category: "Session",
    hidden: true,
    run: () => {
      deadline = 0;
      clearTimeout(timer);
      setArmed(false);
    },
  });
  onSettled(() => {
    releases.push(keyboard.onLayerClose("session.escape.reset"));
    const focused = () =>
      document.activeElement === input && !props.value.editor;
    releases.push(
      keyboard.keymap.bind({
        id: "prompt.newline",
        command: "prompt.newline",
        key: "Shift+Enter",
        inPrompt: true,
        ctx: "prompt",
      }, focused),
    );
    releases.push(
      keyboard.keymap.bind({
        id: "prompt.submit",
        command: "prompt.submit",
        key: "Enter",
        inPrompt: true,
        ctx: "prompt",
      }, focused),
    );
    releases.push(
      keyboard.keymap.bind({
        id: "session.interrupt",
        command: "session.interrupt",
        args: { confirm: true },
        key: "Escape",
        inPrompt: true,
        ctx: "prompt",
        desc: "Esc twice to interrupt",
      }),
    );
    if (!ports.keyboard) releases.push(keyboard.start());
    return () => {
      active = false;
      for (const release of releases) release();
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
        void submitCommand().catch(ctx.fail);
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
          ?.placeholder?.() ??
          "Ask for a change, @ to add files, / for commands"}
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
        }}
      />
      <div class="otk-prompt-actions">
        <div class="otk-prompt-context" aria-label="Next message settings">
          <Show
            when={features.some((feature) => feature.settings)}
            fallback={
              <>
                <span>
                  {selectionLabel(
                    ctx.nextSelection().agent.value,
                    "Default agent",
                  )}
                </span>
                <ModelLabel
                  provider={ctx.nextSelection().model.providerName}
                  name={ctx.nextSelection().model.name}
                />
              </>
            }
          >
            <For each={features}>{(feature) => feature.settings?.()}</For>
          </Show>
        </div>
        <For each={features}>{(feature) => feature.actions?.()}</For>
        <button
          type="submit"
          class="otk-primary otk-send-button"
          aria-label="Send"
          title={armed()
            ? "Esc again to interrupt"
            : "Send (Enter); Shift+Enter for newline; Esc twice to interrupt"}
          disabled={pending() ||
            props.value.chips.some((chip) => chip.pending || chip.error) ||
            !canSubmit() || !hasDraftContent(props.value)}
        >
          <SendIcon />
        </button>
      </div>
      <Show when={error()}>
        <p class="otk-error" role="alert">{error()}</p>
      </Show>
      <For each={features}>{(feature) => feature.overlay?.()}</For>
    </form>
  );
}
