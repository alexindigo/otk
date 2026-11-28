// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, type Element, onSettled, Show } from "solid-js";
import type { SessionDelivery } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import "./MessageDelivery.css" with { type: "text" };

/** In-flow feedback only while a receipt lacks its transcript entry. */
export default function MessageDelivery(
  props: { owner?: SessionDelivery; class?: string },
): Element {
  const [revision, setRevision] = createSignal(0);
  onSettled(() => props.owner?.subscribe(() => setRevision((n) => n + 1)));
  const receipt = () => {
    revision();
    const value = props.owner?.state.receipts.find((r) =>
      !r.entry && (r.phase !== "admitted" || r.feedback)
    );
    return value ? { ...value } : undefined;
  };
  return (
    <Show when={receipt()}>
      {(value) => (
        <div
          class={["otk-message-delivery-slot", props.class]}
          role="status"
          aria-label="Message delivery"
          data-delivery-message={value().messageID}
        >
          <FeedbackStatus
            singleLine
            feedback={value().feedback
              ? {
                ...value().feedback!,
                action: {
                  label: "Reload this session's latest messages",
                  run: () => void props.owner?.reload(),
                },
              }
              : {
                kind: "pending",
                text: value().phase === "submitted"
                  ? "Sending prompt..."
                  : value().phase === "queued"
                  ? "Queued while the session is busy"
                  : "Sent, waiting for opencode",
              }}
          />
        </div>
      )}
    </Show>
  );
}
