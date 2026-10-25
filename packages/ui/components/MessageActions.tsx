// SPDX-License-Identifier: LGPL-3.0-only
import "./MessageActions.css" with { type: "text" };
import { createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { errorMessage } from "@otk/protocol";
import type { ContentTarget } from "../features/transcript-context.tsx";
import { commandHints, useCommandPorts } from "../keyboard/context.tsx";
import { CopyIcon, ForkIcon } from "./ChromeIcons.tsx";
import { hoverIntent } from "./hover-intent.ts";

const actions = {
  prompt: ["prompt.copy"],
  reply: ["reply.fork", "reply.copy"],
};
/** Data-only command consumer; the message supplies its hover region and state. */
export default function MessageActions(props: {
  kind: "prompt" | "reply";
  target: ContentTarget;
  revealed: boolean;
  region(): HTMLElement;
  onReveal(value: boolean): void;
}) {
  const ports = useCommandPorts(), hints = commandHints(ports);
  const [revision, setRevision] = createSignal(0);
  const [pending, setPending] = createSignal("");
  const [error, setError] = createSignal("");
  let active = true;
  onCleanup(() => {
    active = false;
  });
  onSettled(() => {
    const release = ports.commands.subscribe(() =>
      setRevision((value) => value + 1)
    );
    setRevision((value) => value + 1);
    const hover = hoverIntent(props.region(), {
      open: () => props.onReveal(true),
      close: () => props.onReveal(false),
    });
    return () => {
      release();
      hover.dispose();
    };
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
  const run = async (id: string) => {
    if (pending()) return;
    setPending(id);
    setError("");
    try {
      await ports.commands.run(id, props.target);
    } catch (error) {
      if (active) setError(errorMessage(error));
    } finally {
      if (active) setPending("");
    }
  };
  return (
    <span
      class={["otk-message-action-group", { "is-revealed": props.revealed }]}
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
              onClick={() => void run(action().id)}
            >
              <Show when={action().id === "reply.fork"} fallback={<CopyIcon />}>
                <ForkIcon />
              </Show>
            </button>
          )}
        </For>
      </span>
      <Show when={error()}>
        <span class="otk-error" role="alert">{error()}</span>
      </Show>
    </span>
  );
}
