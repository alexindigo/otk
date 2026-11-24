// SPDX-License-Identifier: LGPL-3.0-only
import type { ActionControl, CommandHub, Selection } from "@otk/client";

function observedOpen(
  commands: CommandHub,
  command: string,
  args: unknown,
  target: Selection,
  label: string,
  active?: () => boolean,
): ActionControl {
  return commands.control(command, args, {
    target: { ...target, label },
    active,
    shown: () => {
      const context = commands.context();
      return context.viewing !== false &&
        context.sidecar === target.sidecarId &&
        context.session === target.sessionID;
    },
    unshown:
      "The requested view did not open. Your current view and input were kept.",
    recovery:
      "Open Sessions and choose the session after resolving any unsaved input",
  });
}

/** All explicit child/session links borrow the same guarded command owner. */
export function sessionOpenControl(
  commands: CommandHub,
  id: string,
  label: string,
): ActionControl {
  return observedOpen(commands, "session.child", id, {
    sidecarId: commands.context().sidecar ?? "",
    sessionID: id,
  }, label);
}

/** A selectable row, including the currently selected session. */
export function sessionSelectionControl(
  commands: CommandHub,
  target: Selection,
  label: string,
): ActionControl {
  return observedOpen(commands, "session.open", target, target, label);
}

/** Explicit cross-server Open offers, distinct from ordinary row re-selection. */
export function sessionTargetOpenControl(
  commands: CommandHub,
  target: Selection,
  label: string,
  active?: () => boolean,
): ActionControl {
  return observedOpen(
    commands,
    "session.preview",
    target,
    target,
    label,
    active,
  );
}
