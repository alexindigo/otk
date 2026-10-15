// SPDX-License-Identifier: LGPL-3.0-only
import { createState, type NotificationHub } from "@otk/client";
export type BrowserNotificationStatus =
  | "granted"
  | "default"
  | "denied"
  | "unavailable";
/** Browser permission is independent from the host's requested preference. */
export function registerOsChannel(hub: NotificationHub): {
  state: { status: BrowserNotificationStatus };
  subscribe(
    listener: (state: { status: BrowserNotificationStatus }) => void,
  ): () => void;
  request(): Promise<void>;
  refresh(): void;
  stop(): void;
} {
  let failed = false, stopped = false;
  const status = (): BrowserNotificationStatus =>
    !globalThis.isSecureContext || typeof Notification === "undefined" || failed
      ? "unavailable"
      : Notification.permission;
  const store = createState<{ status: BrowserNotificationStatus }>({
    status: status(),
  });
  const refresh = () =>
    store.update((draft) => {
      draft.status = status();
    });
  const active = new Map<string, Notification>();
  const retract = (id: string) => {
    const n = active.get(id);
    active.delete(id);
    n?.close();
  };
  const release = hub.registerChannel({
    id: "os",
    available: () => status() === "granted",
    retract,
    deliver(note, delivery) {
      retract(note.id);
      try {
        const n = new Notification(note.title, {
          body: note.body,
          tag: note.id,
          silent: true,
        });
        active.set(note.id, n);
        n.addEventListener("click", (event) => {
          event.preventDefault();
          if (!delivery.currentNote()) return;
          // Native focus can precede a queued click. Presentation may be gone;
          // the identity-bound default action remains valid until viewing/replacement.
          void delivery.invokeDefault();
          globalThis.focus();
        });
        n.addEventListener("error", () => {
          if (!delivery.current() || active.get(note.id) !== n) return;
          failed = true;
          refresh();
          delivery.unavailable();
        });
      } catch {
        failed = true;
        refresh();
        delivery.unavailable();
      }
    },
  });
  return {
    state: store.state,
    subscribe: store.subscribe,
    refresh,
    async request() {
      if (typeof Notification === "undefined" || !globalThis.isSecureContext) {
        refresh();
        return;
      }
      try {
        await Notification.requestPermission();
      } catch {
        failed = true;
      }
      if (!stopped) {
        refresh();
        hub.refresh();
      }
    },
    stop() {
      stopped = true;
      release();
    },
  };
}
