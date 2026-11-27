// SPDX-License-Identifier: LGPL-3.0-only
import type { ActionControl, LiveWorkOwner, RunningWork } from "@otk/client";
import { createSignal, createUniqueId, onSettled } from "solid-js";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import ActionButton from "./ActionButton.tsx";
import { CloseIcon } from "./ChromeIcons.tsx";

/** Bind a popover's row controls to the session work owner. */
export function bindWorkTermination(
  owner: () => LiveWorkOwner | undefined,
  kind: RunningWork["kind"],
  noun: string,
) {
  const [revision, setRevision] = createSignal(0);
  onSettled(() => owner()?.subscribe(() => setRevision((value) => value + 1)));
  const ports = useCommandPorts();
  const command = `work.terminate@${createUniqueId()}`;
  const key = (id: string) => `${kind}/${id}`;
  const available = (id: string) => owner()?.canStop(key(id)) ?? false;
  ownedCommand(ports, {
    id: command,
    title: `Terminate ${noun}`,
    category: "Session",
    scope: "control",
    arguments: { type: "string" },
    availability: (_context, id: string) =>
      available(id) ? { available: true } : {
        available: false,
        reason: `This ${noun} cannot be terminated`,
        hidden: true,
      },
    run: (_context, id: string) => owner()?.stop(key(id)),
  });
  return {
    available,
    busy(id: string) {
      revision();
      return owner()?.stopping(key(id));
    },
    action: (id: string, label: string) =>
      ports.commands.control(command, id, {
        target: { label },
        // Request settlement leaves roster membership to native work evidence.
        shown: () => true,
        unshown: "The termination request did not complete.",
        recovery: `Check the ${noun} and try again if it is still running`,
      }),
  };
}

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
