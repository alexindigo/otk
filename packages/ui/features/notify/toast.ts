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
}
/** Keyed active/error chips; transient information owns its exact timer. */
export function registerToastChannel(
  hub: NotificationHub,
): { model: ToastsModel; stop(): void } {
  const store = createState<{ items: ToastItem[] }>({ items: [] });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const retract = (id: string) => {
    clearTimeout(timers.get(id));
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
      store.update((draft) => {
        draft.items = [...draft.items, { note, delivery }];
      });
      if (note.kind === "info" || note.kind === "done") {
        timers.set(note.id, setTimeout(() => delivery.dismiss(), 6000));
      }
    },
  });
  return {
    model: { state: store.state, subscribe: store.subscribe },
    stop: () => {
      release();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
