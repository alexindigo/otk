// SPDX-License-Identifier: LGPL-3.0-only
import { notificationFailure } from "./failure-features.ts";
import { belongsToSession, type Preferences } from "@otk/protocol";
import type { Note, NotificationPolicy } from "./notifications.ts";
export interface NotificationContext {
  focused: boolean;
  visible: boolean;
  /** The session whose view (transcript and request docks) is on screen. */
  open?: { sidecar: string; session: string };
  /** Session tree lookup; request docks present their descendants' requests. */
  lookup?(sidecar: string, id: string): { parentID?: string } | undefined;
  prefs: Pick<
    Preferences,
    "notify.toast" | "notify.os" | "notify.sound" | "notify.badge"
  >;
}
/** One presentation per item. The open view presents its own session's notes,
 * and its request docks present every request of its session and descendants
 * (the docks' own scope); everything else is presented by a notification. */
export function presentedOnScreen(
  note: Pick<Note, "kind" | "sessionRef">,
  ctx: Pick<NotificationContext, "focused" | "visible" | "open" | "lookup">,
): boolean {
  const ref = note.sessionRef, open = ctx.open;
  if (!ref || !open || !ctx.focused || !ctx.visible) return false;
  if (ref.sidecar !== open.sidecar) return false;
  if (ref.session === open.session) return true;
  return (note.kind === "permission" || note.kind === "question") &&
    !!ctx.lookup &&
    belongsToSession(
      ref.session,
      open.session,
      (id) => ctx.lookup!(ref.sidecar, id),
    );
}
/** Shipped policy is a feature, not a concrete-channel dependency in the hub. */
export function notificationPolicy(
  context: () => NotificationContext,
): NotificationPolicy {
  return (note, available, fresh, dismissed) => {
    const ctx = context(), prefs = ctx.prefs;
    if (!note.sessionRef) return { channels: ["toast"] };
    if (presentedOnScreen(note, ctx)) return { channels: [] };
    const channels: string[] = [];
    const os = !dismissed && !(ctx.focused && ctx.visible) &&
      prefs["notify.os"] &&
      available("os");
    if (os) channels.push("os");
    else if (!dismissed && prefs["notify.toast"]) channels.push("toast");
    if (!dismissed && fresh && prefs["notify.sound"]) channels.push("sound");
    if (
      prefs["notify.badge"] && note.kind !== "error" &&
      !notificationFailure(note)
    ) channels.push("badge");
    return {
      channels,
      fallback: prefs["notify.toast"] ? { from: "os", to: "toast" } : undefined,
    };
  };
}
