// SPDX-License-Identifier: LGPL-3.0-only
import "./MessageActions.css" with { type: "text" };
import {
  createSignal,
  For,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import {
  commandFailureFacts,
  type ContextAction,
  errorFeedback,
  type FailureValue,
  failureValue,
} from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import type { ContentTarget } from "../features/transcript-context.tsx";
import { commandHints, useCommandPorts } from "../keyboard/context.tsx";
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  ForkIcon,
  RevertIcon,
} from "./ChromeIcons.tsx";
import { RunIcon } from "./tools/ToolIcons.tsx";

const actions = {
  prompt: ["prompt.revert", "prompt.copy"],
  reply: ["reply.fork", "reply.copy"],
  code: ["code.copy", "code.run"],
};
const COPY_FEEDBACK_MS = 1500;
/** Data-only command consumer; availability never depends on pointer state. */
export default function MessageActions(props: {
  kind: keyof typeof actions;
  class?: string;
  target: ContentTarget;
  failure?: "line" | "marker";
}) {
  const ports = useCommandPorts(), hints = commandHints(ports);
  const [revision, setRevision] = createSignal(0);
  const [pending, setPending] = createSignal("");
  const [error, setError] = createSignal<{ id: string; value: FailureValue }>();
  const [copied, setCopied] = createSignal("");
  let stopConfirmation: (() => void) | undefined;
  let active = true;
  onCleanup(() => {
    active = false;
    stopConfirmation?.();
  });
  onSettled(() => {
    const release = ports.commands.subscribe(() =>
      setRevision((value) => value + 1)
    );
    setRevision((value) => value + 1);
    return release;
  });
  const available = () => {
    revision();
    const commands = ports.commands.contextActions({
      kind: props.kind,
      data: props.target,
    }, props.kind === "code");
    return actions[props.kind].flatMap((id) =>
      commands.filter((command) => command.id === id)
    );
  };
  const run = async (action: ContextAction) => {
    if (pending() || action.unavailable) return;
    const { id } = action;
    const facts = commandFailureFacts(action);
    setPending(id);
    setError(undefined);
    try {
      await ports.commands.run(id, props.target);
      if (active && id.endsWith(".copy")) {
        stopConfirmation?.();
        setCopied(id);
        stopConfirmation = clearCopied(() => setCopied(""));
      }
    } catch (error) {
      if (ports.failureOwned?.(error)) return;
      if (active) {
        setError({
          id,
          value: failureValue(error, {
            ...facts,
            target: props.target,
          }),
        });
      }
    } finally {
      if (active) setPending("");
    }
  };
  const feedback = () => errorFeedback(error()?.value ?? "");
  const marker = (id: string) =>
    props.failure === "marker" && error()?.id === id && error()?.value
      ? feedback()?.text
      : undefined;
  return (
    <span
      class={["otk-message-action-group", props.class]}
    >
      <span class="otk-message-actions">
        <For each={available()} keyed={(action) => action.id}>
          {(action) => {
            const shown = () => marker(action().id);
            return (
              <button
                type="button"
                class={["otk-icon-button", {
                  "otk-copy-message": action().id === "reply.copy",
                  "is-done": copied() === action().id && !shown(),
                }]}
                data-message-command={action().id}
                aria-label={shown()
                  ? `${action().title} failed`
                  : action().title}
                disabled={action().unavailable !== undefined}
                aria-disabled={action().unavailable ? "true" : undefined}
                aria-description={action().unavailable ?? shown()}
                title={action().unavailable ?? shown() ??
                  hints.title(action().id, action().title)}
                aria-busy={pending() === action().id ? "true" : undefined}
                onClick={() => void run(action())}
              >
                <Switch fallback={<CopyIcon />}>
                  <Match when={shown()}>
                    <AlertIcon />
                  </Match>
                  <Match when={copied() === action().id}>
                    <CheckIcon />
                  </Match>
                  <Match when={action().id === "reply.fork"}>
                    <ForkIcon />
                  </Match>
                  <Match when={action().id === "prompt.revert"}>
                    <RevertIcon />
                  </Match>
                  <Match when={action().id === "code.run"}>
                    <RunIcon />
                  </Match>
                </Switch>
              </button>
            );
          }}
        </For>
      </span>
      <span class="otk-copy-confirmation" role="status">
        {copied() ? "Copied" : ""}
      </span>
      <Show when={props.failure !== "marker" && error()?.value}>
        <FeedbackStatus feedback={feedback()} />
      </Show>
    </span>
  );
}

/** Confirmation lifetime is independent of pointer and button visibility. */
function clearCopied(clear: () => void): () => void {
  const timer = setTimeout(clear, COPY_FEEDBACK_MS);
  return () => clearTimeout(timer);
}
