// SPDX-License-Identifier: LGPL-3.0-only
import "./Prompt.css" with { type: "text" };
import ContentTextarea from "./ContentTextarea.tsx";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import {
  type DraftChange,
  editDraft,
  hasDraftContent,
  serialize,
} from "./prompt/model.ts";
import { createCompletion } from "./prompt/Completion.tsx";
import { useUiRegistries } from "../registries/context.tsx";
import type { PromptContext, PromptProps } from "../registries/prompt.ts";
import {
  commandHints,
  ownedCommand,
  useCommandPorts,
} from "../keyboard/context.tsx";
import { createKeyboard } from "../keyboard/dispatcher.ts";
import { useSessionPorts } from "../registries/session.tsx";
import { SendIcon } from "./ChromeIcons.tsx";
import {
  actionFeedback,
  clearDraft,
  createFailurePresenter,
  createSubmissionIntent,
  effectiveSelection,
  type Feedback,
} from "@otk/client";
import ComposerNotice from "./ComposerNotice.tsx";
import OperationFeedback from "./OperationFeedback.tsx";
import type { PromptChoices } from "../registries/prompt.ts";
import { ModelLabel, selectionLabel } from "./prompt/labels.tsx";
import { contextTarget } from "./context-target.ts";

const INTERRUPT_WINDOW_MS = 5000;

/** Input and submission lifetime; concrete prompt concepts are injected features. */
export default function Prompt(props: PromptProps): import("solid-js").Element {
  const session = useSessionPorts();
  const intent = createSubmissionIntent<PromptProps["value"]>({
    capture: (value) => value,
    presenter: createFailurePresenter(),
  });
  const [revision, setRevision] = createSignal(0);
  onCleanup(intent.subscribe(() => setRevision(revision() + 1)));
  const pending = () => {
    revision();
    return intent.state.pending;
  };
  const [feedback, setFeedback] = createSignal<Feedback>(),
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
  const hints = commandHints({ ...ports, keyboard });
  const submitTitle = () => {
    const newline = hints.keys("prompt.newline");
    const interrupt = hints.keys("session.interrupt");
    if (armed() && interrupt) return `${interrupt} again to interrupt`;
    return [
      hints.title("prompt.submit", "Send"),
      newline && `${newline} for newline`,
      interrupt && `${interrupt} twice to interrupt`,
    ].filter(Boolean).join("; ");
  };
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
    ...session,
    commands: ports.commands,
    keyboard,
    own: (release) => releases.push(release),
    mount: (setup) => onSettled(setup),
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
      if (session?.feedback) session.feedback.fail(error);
      else if (active) setFeedback(actionFeedback(error));
    },
    acceptFiles: async (files) => {
      for (const feature of features) await feature.drop?.(files);
    },
  };
  const features = useUiRegistries().prompt.create(ctx);
  // Invoke synchronously so feature-owned preventDefault still precedes native
  // paste, then contain either a synchronous throw or an asynchronous rejection.
  const interact = (action: () => void | Promise<void>) => {
    try {
      void Promise.resolve(action()).catch(ctx.fail);
    } catch (error) {
      ctx.fail(error);
    }
  };
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
    session?.feedback?.clear();
    setFeedback(undefined);
    input.focus();
    await ctx.ready();
    if (!active || !canSubmit()) return;
    const draft = change((current) => current);
    for (const feature of features) {
      if (await feature.beforeSubmit?.(draft)) return;
    }
    if (
      !active || !hasDraftContent(draft) || !canSubmit() ||
      draft.chips.some((chip) => chip.pending || chip.error)
    ) return;
    return draft;
  };
  const performSend = async (draft: PromptProps["value"]) => {
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
      try {
        await feature.submitted?.(draft, selection, handled);
      } catch (cause) {
        ctx.fail(cause);
      }
    }
  };
  const send = ownedCommand(ports, {
    id: "prompt.send",
    title: "Send prompt",
    category: "Prompt",
    arguments: {
      type: "object",
      properties: {
        parts: { type: "array" },
        mode: { type: "string", enum: ["normal", "shell"] },
        selection: { type: "object" },
      },
    },
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
    enabled: canSubmit,
    run: () => intent.submit(submit, performSend),
  });
  ownedCommand(ports, {
    id: "prompt.newline",
    title: "Insert newline",
    category: "Prompt",
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
    arguments: {
      type: "object",
      optional: true,
      properties: { confirm: { type: "boolean", optional: true } },
    },
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
        deadline = Date.now() + INTERRUPT_WINDOW_MS;
        setArmed(true);
        timer = setTimeout(() => {
          deadline = 0;
          setArmed(false);
        }, INTERRUPT_WINDOW_MS);
      }
    },
  });
  ownedCommand(ports, {
    id: "session.escape.reset",
    title: "Reset interrupt sequence",
    category: "Session",
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
        desc: "Press twice to interrupt",
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
      ref={contextTarget(() => ({
        kind: "composer",
        area: true,
        data: undefined,
      }))}
      class="otk-prompt"
      aria-label="Composer"
      aria-busy={pending() || features.some((feature) => feature.pending?.())
        ? "true"
        : "false"}
      aria-description={pending()
        ? "Preparing or sending prompt…"
        : features.some((feature) => feature.pending?.())
        ? "Loading message settings…"
        : undefined}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        interact(() =>
          ctx.acceptFiles(Array.from(event.dataTransfer?.files || []))
        );
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
      <ContentTextarea
        class="otk-prompt-input"
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
              interact(() => feature.paste!(event));
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
                <span class="otk-prompt-setting">
                  {selectionLabel(
                    ctx.nextSelection().agent.value,
                    "Default agent",
                  )}
                </span>
                <ModelLabel
                  class="otk-prompt-setting"
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
        <Show when={armed()}>
          <span
            class="otk-control-label"
            data-interrupt-confirmation="true"
            role="status"
          >
            {submitTitle()}
          </span>
        </Show>
        <div class="otk-prompt-send-slot">
          <Show
            when={!pending() && canSubmit() && hasDraftContent(props.value) &&
              !props.value.chips.some((chip) => chip.pending || chip.error)}
          >
            <button
              type="submit"
              class="otk-primary otk-send-button"
              aria-label="Send"
              title={submitTitle()}
            >
              <SendIcon />
            </button>
          </Show>
        </div>
      </div>
      <Show when={!session?.feedback && (pending() || feedback())}>
        <ComposerNotice>
          <OperationFeedback
            feedback={feedback() ??
              { kind: "pending", text: "Sending prompt…" }}
          />
        </ComposerNotice>
      </Show>
      <For each={features}>{(feature) => feature.overlay?.()}</For>
    </form>
  );
}
