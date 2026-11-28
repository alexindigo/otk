// SPDX-License-Identifier: LGPL-3.0-only
import type { DraftRecovery } from "@otk/client";
import type { Element } from "solid-js";
import OperationFeedback from "./OperationFeedback.tsx";

/** The same recovery and explicit discard actions in either notice lane. */
export default function DraftRecoveryNotice(
  props: { recovery: DraftRecovery },
): Element {
  const recovery = () => props.recovery;
  return (
    <OperationFeedback
      feedback={{
        kind: "info",
        text: recovery().cause === "stop-unconfirmed"
          ? "Couldn't confirm the stop; your message is kept."
          : recovery().kind === "uncertain"
          ? "Send not confirmed. The submitted draft is kept separately."
          : `${
            recovery().cause === "withdrawn"
              ? "Stopped before it started. "
              : ""
          }Draft kept separately: ${
            recovery().draft.editor?.text || recovery().draft.input.trim() ||
            recovery().draft.chips.map((chip) => chip.label).join(", ") ||
            "Empty draft"
          }`,
        action: {
          label: recovery().kind === "uncertain"
            ? "Check send"
            : "Recover draft",
          run: () => recovery().run(),
        },
      }}
      dismissLabel="Discard draft"
      onDismiss={() => recovery().discard()}
    />
  );
}
