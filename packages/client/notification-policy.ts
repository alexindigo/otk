// SPDX-License-Identifier: LGPL-3.0-only
import type { Preferences } from "@otk/protocol";
import type { NotificationPolicy } from "./notifications.ts";
export interface NotificationContext {
  focused: boolean;
  visible: boolean;
  open?: { sidecar: string; session: string };
  prefs: Pick<
    Preferences,
    "notify.toast" | "notify.os" | "notify.sound" | "notify.badge"
  >;
}
/** Shipped policy is a feature, not a concrete-channel dependency in the hub. */
export function notificationPolicy(
  context: () => NotificationContext,
): NotificationPolicy {
  return (note, available, fresh) => {
    const ctx = context(), prefs = ctx.prefs;
    if (!note.sessionRef) return { channels: ["toast"] };
    const viewing = ctx.focused && ctx.visible &&
      ctx.open?.sidecar === note.sessionRef.sidecar &&
      ctx.open?.session === note.sessionRef.session;
    if (viewing) return { channels: [] };
    const channels: string[] = [];
    const os = !(ctx.focused && ctx.visible) && prefs["notify.os"] &&
      available("os");
    if (os) channels.push("os");
    else if (prefs["notify.toast"]) channels.push("toast");
    if (fresh && prefs["notify.sound"]) channels.push("sound");
    if (prefs["notify.badge"]) channels.push("badge");
    return {
      channels,
      fallback: prefs["notify.toast"] ? { from: "os", to: "toast" } : undefined,
    };
  };
}
