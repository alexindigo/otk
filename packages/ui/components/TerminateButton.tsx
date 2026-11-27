// SPDX-License-Identifier: LGPL-3.0-only
import type { ActionControl } from "@otk/client";
import ActionButton from "./ActionButton.tsx";
import { CloseIcon } from "./ChromeIcons.tsx";

/** Ends one item of work, not the session's current turn. */
export default function TerminateButton(props: {
  name: string;
  action: ActionControl;
  busy?: boolean;
}) {
  const label = () => `Terminate ${props.name}`;
  return (
    <ActionButton
      class="otk-icon-button"
      action={props.action}
      label={label()}
      title={label()}
      pendingLabel="Terminating..."
      busy={props.busy}
    >
      <CloseIcon />
    </ActionButton>
  );
}
