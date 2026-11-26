// SPDX-License-Identifier: LGPL-3.0-only
import {
  createState,
  type Note,
  type NoteDelivery,
  type NotificationHub,
} from "@otk/client";
export interface ToastItem {
  note: Note;
  delivery: NoteDelivery;
}
export interface ToastsModel {
  state: { items: ToastItem[] };
  subscribe(listener: (state: { items: ToastItem[] }) => void): () => void;
  hold(id: string, held: boolean): void;
}
const AUTO_DISMISS_MS = 6000;
/** Keyed input, error and server chips persist; transient information owns its timer. */
export function registerToastChannel(
  hub: NotificationHub,
): { model: ToastsModel; stop(): void } {
  const store = createState<{ items: ToastItem[] }>({ items: [] });
  const timers = new Map<string, {
    delivery: NoteDelivery;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  const schedule = (expiry: NonNullable<ReturnType<typeof timers.get>>) => {
    expiry.timer = setTimeout(() => expiry.delivery.dismiss(), AUTO_DISMISS_MS);
  };
  const hold = (id: string, held: boolean) => {
    const expiry = timers.get(id);
    if (!expiry) return;
    if (held) {
      clearTimeout(expiry.timer);
      expiry.timer = undefined;
    } else if (expiry.timer === undefined) schedule(expiry);
  };
  const retract = (id: string) => {
    clearTimeout(timers.get(id)?.timer);
    timers.delete(id);
    store.update((draft) => {
      draft.items = draft.items.filter((item) => item.note.id !== id);
    });
  };
  const release = hub.registerChannel({
    id: "toast",
    available: () => true,
    retract,
    deliver(note, delivery) {
      retract(note.id);
      if (note.kind === "info" || note.kind === "done") {
        const expiry = { delivery };
        timers.set(note.id, expiry);
        schedule(expiry);
      }
      store.update((draft) => {
        draft.items = [{ note, delivery }, ...draft.items];
      });
    },
  });
  return {
    model: { state: store.state, subscribe: store.subscribe, hold },
    stop: () => {
      release();
      for (const { timer } of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
