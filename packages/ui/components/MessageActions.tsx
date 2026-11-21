// SPDX-License-Identifier: LGPL-3.0-only
import "./MessageActions.css" with { type: "text" };
import { createSignal, For, onCleanup, onSettled, Show } from "solid-js";
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
import { CopyIcon, ForkIcon, RevertIcon } from "./ChromeIcons.tsx";

const actions = {
  prompt: ["prompt.revert", "prompt.copy"],
  reply: ["reply.fork", "reply.copy"],
};
/** Data-only command consumer; availability never depends on pointer state. */
export default function MessageActions(props: {
  kind: "prompt" | "reply";
  class?: string;
  target: ContentTarget;
}) {
  const ports = useCommandPorts(), hints = commandHints(ports);
  const [revision, setRevision] = createSignal(0);
  const [pending, setPending] = createSignal("");
  const [error, setError] = createSignal<FailureValue>("");
  let active = true;
  onCleanup(() => {
    active = false;
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
    });
    return actions[props.kind].flatMap((id) =>
      commands.filter((command) => command.id === id)
    );
  };
  const run = async (action: ContextAction) => {
    if (pending()) return;
    const { id } = action;
    const facts = commandFailureFacts(action);
    setPending(id);
    setError("");
    try {
      await ports.commands.run(id, props.target);
    } catch (error) {
      if (ports.failureOwned?.(error)) return;
      if (active) {
        setError(
          failureValue(error, {
            ...facts,
            target: props.target,
          }),
        );
      }
    } finally {
      if (active) setPending("");
    }
  };
  return (
    <span
      class={["otk-message-action-group", props.class]}
    >
      <span class="otk-message-actions">
        <For each={available()} keyed={(action) => action.id}>
          {(action) => (
            <button
              type="button"
              class={["otk-icon-button", {
                "otk-copy-message": action().id === "reply.copy",
              }]}
              data-message-command={action().id}
              aria-label={action().title}
              title={hints.title(action().id, action().title)}
              aria-busy={pending() === action().id ? "true" : undefined}
              onClick={() => void run(action())}
            >
              <Show
                when={action().id === "reply.fork"}
                fallback={
                  <Show
                    when={action().id === "prompt.revert"}
                    fallback={<CopyIcon />}
                  >
                    <RevertIcon />
                  </Show>
                }
              >
                <ForkIcon />
              </Show>
            </button>
          )}
        </For>
      </span>
      <Show when={error()}>
        <FeedbackStatus feedback={errorFeedback(error())} />
      </Show>
    </span>
  );
}
