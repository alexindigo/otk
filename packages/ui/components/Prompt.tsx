// SPDX-License-Identifier: LGPL-3.0-only
import "./Prompt.css" with { type: "text" };
import ContentTextarea from "./ContentTextarea.tsx";
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
import {
  commandHints,
  ownedCommand,
  useCommandPorts,
} from "../keyboard/context.tsx";
import { createKeyboard } from "../keyboard/dispatcher.ts";
import { useSessionPorts } from "../registries/session.tsx";
import { SendIcon, SettingsIcon, StopIcon } from "./ChromeIcons.tsx";
import {
  actionFeedback,
  composerLabel,
  type ComposerSource,
  createComposerAction,
  effectiveSelection,
  type Feedback,
} from "@otk/client";
import ComposerNotice, { ComposerActionNotice } from "./ComposerNotice.tsx";
import OperationFeedback from "./OperationFeedback.tsx";
import { ModelLabel, PromptSetting, selectionLabel } from "./prompt/labels.tsx";
import { contextTarget } from "./context-target.ts";
import PrimaryAction from "./PrimaryAction.tsx";
import { bindPrimaryAction } from "../state/primary-action.ts";
import OverflowRow from "./OverflowRow.tsx";
import Popover from "./surface/Popover.tsx";

const INTERRUPT_WINDOW_MS = 5000;
const SETTINGS_KEY = "settings";
const SETTINGS_LABEL = "Next message settings";

/** Input and submission lifetime; concrete prompt concepts are injected features. */
export default function Prompt(props: PromptProps): import("solid-js").Element {
  const session = useSessionPorts();
  const pending = () => primaryState().sending;
  const [feedback, setFeedback] = createSignal<Feedback>(),
    [lastRefusal, setRefusal] = createSignal<
      {
        reason: string;
        source: ComposerSource;
      } | undefined
    >(undefined, {
      equals: (a, b) => a?.reason === b?.reason && a?.source === b?.source,
    }),
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
  onSettled(() =>
    ports.keyboard?.focusHome(() =>
      props.suspended || props.value.editor ? undefined : input
    )
  );
  const hints = commandHints({ ...ports, keyboard });
  const submitTitle = () => {
    const newline = hints.keys("prompt.newline");
    const interrupt = hints.keys("session.interrupt");
    if (armed() && interrupt) return `${interrupt} again to interrupt`;
    return [
      hints.title("prompt.submit", composerLabel("send")),
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
  const facts = (draft: PromptProps["value"]) => ({
    active,
    suspended: !!props.suspended,
    connected: props.connected,
    supported:
      features.map((feature) => feature.enabled?.()).find((value) =>
        value !== undefined
      ) ?? ctx.supports("prompt"),
    stopSupported: ctx.supports("prompt"),
    content: hasDraftContent(draft),
    chips: draft.chips,
    ...props.activity(),
  });
  const performSend = async (
    draft: PromptProps["value"],
    activation: string,
  ) => {
    const capture = props.captureSend?.(draft);
    const draftSend = capture && { ...capture, activation };
    const parts = serialize(draft);
    const effective = ctx.nextSelection(draft);
    const selection = effective.input;
    let handled = false;
    for (const feature of features) {
      if (await feature.submit?.(draft, parts, selection, draftSend)) {
        handled = true;
        break;
      }
    }
    if (!handled) {
      await props.onSubmit(parts, draft.mode, selection, draftSend);
    }
    for (const feature of features) {
      try {
        await feature.submitted?.(draft, selection, handled);
      } catch (cause) {
        ctx.fail(cause);
      }
    }
  };
  const primary = createComposerAction({
    facts,
    draft: () => props.value,
    local: (draft) => {
      for (const feature of features) {
        const command = feature.localCommand?.(draft);
        if (command) return command;
      }
    },
    prepare: ctx.ready,
    send: performSend,
    stop: props.onStop,
    refuse: (reason, _source, recheckAs) => {
      if (active) setRefusal({ reason, source: recheckAs });
    },
    begin: () => {
      setRefusal(undefined);
      session?.feedback?.clear();
      setFeedback(undefined);
    },
  });
  const activate = (source: ComposerSource) =>
    primary.activate(source).catch(ctx.fail);
  const primaryState = bindPrimaryAction(primary);
  const refusal = () => {
    const last = lastRefusal();
    if (!last) return;
    primaryState(); // The pending reservation is an external owner signal.
    if (primary.verdict(last.source).reason === last.reason) return last.reason;
  };
  createEffect(refusal, (reason, previous) => {
    props.onActivationNotice?.(reason);
    if (!reason && previous) setRefusal(undefined);
  });
  ownedCommand(ports, {
    id: "prompt.focus",
    title: "Focus prompt",
    category: "Prompt",
    enabled: () => !props.suspended,
    run: () => ctx.focus(),
  });
  ownedCommand(ports, {
    id: "prompt.submit",
    title: "Send prompt",
    category: "Prompt",
    // Keymap owns routing, not admission: even a refused Enter is consumed.
    run: () => activate("enter"),
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
    name: "interrupt",
    arguments: {
      type: "object",
      optional: true,
      properties: { confirm: { type: "boolean", optional: true } },
    },
    title: "Interrupt session",
    category: "Session",
    enabled: () => primary.verdict("interrupt").available,
    run: async (_context, args?: { confirm?: boolean }) => {
      if (!args?.confirm) return await activate("interrupt");
      if (Date.now() < deadline) {
        deadline = 0;
        clearTimeout(timer);
        setArmed(false);
        await activate("interrupt");
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
        ? "Preparing or sending prompt..."
        : features.some((feature) => feature.pending?.())
        ? "Loading message settings..."
        : undefined}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        interact(() =>
          ctx.acceptFiles(Array.from(event.dataTransfer?.files || []))
        );
      }}
      onSubmit={(event) => event.preventDefault()}
    >
      <Show when={!props.onActivationNotice && refusal()}>
        {(reason) => (
          <ComposerNotice>
            <ComposerActionNotice text={reason()} />
          </ComposerNotice>
        )}
      </Show>
      <Show
        when={!refusal() && !session?.feedback && (pending() || feedback())}
      >
        <ComposerNotice>
          <OperationFeedback
            feedback={feedback() ?? { kind: "pending", text: "Sending" }}
          />
        </ComposerNotice>
      </Show>
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
          setRefusal(undefined);
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
        <Show when={armed()}>
          <span
            class="otk-control-label otk-prompt-interrupt"
            data-interrupt-confirmation="true"
            role="status"
          >
            {submitTitle()}
          </span>
        </Show>
        <OverflowRow
          items={[{ key: SETTINGS_KEY }]}
          required={[SETTINGS_KEY]}
          intrinsic={false}
          singleLine
          measure={() => <span class="otk-prompt-context-measure" />}
          compactMeasure={() => <span class="otk-prompt-context-icon" />}
          more={() => null}
        >
          {(_item, compact) => {
            const settings = (inPopover = false) => (
              <div
                class={["otk-prompt-context", { "is-in-popover": inPopover }]}
                role="group"
                aria-label={SETTINGS_LABEL}
              >
                <Show
                  when={features.some((feature) => feature.settings)}
                  fallback={
                    <>
                      <PromptSetting>
                        {selectionLabel(
                          ctx.nextSelection().agent.value,
                          "Default agent",
                        )}
                      </PromptSetting>
                      <PromptSetting>
                        <ModelLabel
                          provider={ctx.nextSelection().model.providerName}
                          name={ctx.nextSelection().model.name}
                        />
                      </PromptSetting>
                    </>
                  }
                >
                  <For each={features}>{(feature) => feature.settings?.()}</For>
                </Show>
              </div>
            );
            return (
              <Show when={compact()} fallback={settings()}>
                <Popover
                  label={SETTINGS_LABEL}
                  title={SETTINGS_LABEL}
                  trigger={<SettingsIcon />}
                  triggerClass="otk-icon-button otk-prompt-context-icon"
                  size="content"
                >
                  {settings(true)}
                </Popover>
              </Show>
            );
          }}
        </OverflowRow>
        <div class="otk-prompt-action-group">
          <For each={features}>{(feature) => feature.actions?.()}</For>
          <div class="otk-prompt-send-slot">
            <PrimaryAction
              state={primaryState()}
              class="otk-primary otk-send-button"
              title={primaryState().mode === "stop"
                ? primaryState().label
                : submitTitle()}
              description={primaryState().mode === "stop"
                ? (props.activity().unstarted
                  ? "Stop and return the message to the composer"
                  : "Stop the response")
                : undefined}
              onInvoke={() => void activate("button")}
            >
              {primaryState().mode === "stop" ? <StopIcon /> : <SendIcon />}
            </PrimaryAction>
          </div>
        </div>
      </div>
      <For each={features}>{(feature) => feature.overlay?.()}</For>
    </form>
  );
}
