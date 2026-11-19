// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import { useSessionPorts } from "../registries/session.tsx";
export function RequestReopen() {
  const session = useSessionPorts();
  const dismissed = () => {
    session.permissions();
    session.questions();
    session.forms?.();
    return session.requests?.dismissed(session.sessionID(), session.entry) ??
      [];
  };
  return (
    <For each={dismissed()} keyed={(request) => request.id}>
      {(request) => (
        <button
          type="button"
          class="otk-pill"
          onClick={() =>
            session.requests?.show(
              request().kind === "permission" ? "permission" : "form",
              request().id,
            )}
        >
          Pending {request().permission
            ? "permission"
            : request().question
            ? "question"
            : "form"}: reopen
        </button>
      )}
    </For>
  );
}
/** Presentation-only intent. It never answers or cancels native work. */
export default function RequestDismiss(props: { onDismiss?: () => void }) {
  return (
    <Show when={props.onDismiss}>
      <button
        type="button"
        class="otk-pill"
        data-request-dismiss
        onClick={() => props.onDismiss?.()}
      >
        Dismiss locally
      </button>
    </Show>
  );
}
