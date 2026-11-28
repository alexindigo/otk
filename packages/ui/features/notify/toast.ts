// SPDX-License-Identifier: LGPL-3.0-only
import {
  createState,
  type Disclosures,
  type Note,
  type NoteDelivery,
  type NotificationHub,
} from "@otk/client";
export interface ToastItem {
  note: Note;
  delivery: NoteDelivery;
}
interface ToastState {
  items: readonly ToastItem[];
  page: number;
}
export interface ToastsModel {
  readonly state: Readonly<ToastState>;
  subscribe(listener: (state: Readonly<ToastState>) => void): () => void;
  more(): void;
  visible(): ToastItem[];
  remaining(): ToastItem[];
  hold(id: string, held: boolean): void;
}
export const TOAST_PAGE_SIZE = 3;
const AUTO_DISMISS_MS = 6000;
const lastPage = (count: number) =>
  Math.max(0, Math.ceil(count / TOAST_PAGE_SIZE) - 1);
/** Keyed input, error and server chips persist; transient information owns its timer. */
export function registerToastChannel(
  hub: NotificationHub,
  disclosures?: Disclosures,
): { model: ToastsModel; stop(): void } {
  const store = createState<ToastState>({ items: [], page: 0 });
  const pageStart = () => store.state.page * TOAST_PAGE_SIZE;
  const setItems = (items: ToastItem[]) => {
    store.update((draft) => {
      draft.items = items;
      draft.page = Math.min(draft.page, lastPage(items.length));
    });
  };
  const without = (id: string) =>
    store.state.items.filter((item) => item.note.id !== id);
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
  const cancelExpiry = (id: string) => {
    clearTimeout(timers.get(id)?.timer);
    timers.delete(id);
  };
  const release = hub.registerChannel({
    id: "toast",
    available: () => true,
    retract(id) {
      cancelExpiry(id);
      disclosures?.retire({ scope: id });
      setItems(without(id));
    },
    deliver(note, delivery) {
      cancelExpiry(note.id);
      if (note.kind === "info" || note.kind === "done") {
        const expiry = { delivery };
        timers.set(note.id, expiry);
        schedule(expiry);
      }
      setItems([{ note, delivery }, ...without(note.id)]);
    },
  });
  return {
    model: {
      state: store.state,
      subscribe: store.subscribe,
      more() {
        store.update((draft) => {
          draft.page = draft.page < lastPage(draft.items.length)
            ? draft.page + 1
            : 0;
        });
      },
      visible() {
        const start = pageStart();
        return store.state.items.slice(start, start + TOAST_PAGE_SIZE);
      },
      remaining() {
        const start = pageStart();
        return store.state.items.filter((_item, index) =>
          index < start || index >= start + TOAST_PAGE_SIZE
        );
      },
      hold,
    },
    stop: () => {
      release();
      for (const { timer } of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
