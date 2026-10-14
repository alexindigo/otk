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
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import { createKeyboard } from "../keyboard/dispatcher.ts";

/** Input and submission lifetime; concrete prompt concepts are injected features. */
export default function Prompt(props: PromptProps): import("solid-js").Element {
  const [pending, setPending] = createSignal(false),
    [error, setError] = createSignal(""),
    [armed, setArmed] = createSignal(false),
    [caret, setCaret] = createSignal(0);
  let active = true, input!: HTMLTextAreaElement;
  let deadline = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const ports = useCommandPorts();
  const keyboard = ports.keyboard ??
    createKeyboard(ports.commands, (error) => ctx.fail(error));
  const releases: (() => void)[] = [];
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
    commands: ports.commands,
    keyboard,
    own: (release) => releases.push(release),
    props,
    change,
    caret,
    active: () => active,
    selection: () => ({ start: input.selectionStart, end: input.selectionEnd }),
    focus: () => input.focus(),
    focused: () => document.activeElement === input && !props.value.editor,
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
      if (!handled) await send({ parts, mode: draft.mode, agent: draft.agent });
      if (active) {
        for (const feature of features) feature.submitted?.();
        change((current) =>
          current === draft ? { ...emptyDraft(), agent: draft.agent } : current
        );
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
        agent?: string;
      },
    ) => props.onSubmit(args.parts, args.mode, args.agent),
  });
  const submitCommand = ownedCommand(ports, {
    id: "prompt.submit",
    title: "Send prompt",
    category: "Prompt",
    hidden: true,
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
      props.connected && props.promptEnabled !== false && props.busy !== false,
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
