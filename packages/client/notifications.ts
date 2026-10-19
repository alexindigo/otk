// SPDX-License-Identifier: LGPL-3.0-only
export interface NoteAction {
  readonly label: string;
  readonly command: string;
  readonly args?: unknown;
  readonly default?: boolean;
}
export interface Note {
  readonly id: string;
  readonly kind: "done" | "permission" | "question" | "error" | "info";
  readonly sessionRef?: { readonly sidecar: string; readonly session: string };
  readonly title: string;
  readonly body?: string;
  /** Feature-owned, structured-cloneable detail; channels may ignore it. */
  readonly detail?: unknown;
  readonly actions: readonly NoteAction[];
}
/** A port belongs to this delivery, not just to a replaceable string key. */
export interface NoteDelivery {
  current(): boolean;
  currentNote(): boolean;
  dismiss(): void;
  invoke(action: NoteAction): Promise<void>;
  invokeDefault(): Promise<void>;
  unavailable(): void;
}
export interface NotificationChannel {
  readonly id: string;
  available(): boolean;
  deliver(note: Note, delivery: NoteDelivery): void;
  retract(id: string): void;
}
export interface NotificationRoute {
  readonly channels: readonly string[];
  readonly fallback?: { readonly from: string; readonly to: string };
}
export type NotificationPolicy = (
  note: Note,
  available: (channel: string) => boolean,
  fresh: boolean,
) => NotificationRoute;
interface ActiveNote {
  note: Note;
  deliveries: Map<string, NoteDelivery>;
  dismissed: Set<string>;
}
/** Empty registry: selected policy, channels and command invocation are injected. */
export class NotificationHub {
  #channels = new Map<string, NotificationChannel>();
  #notes = new Map<string, ActiveNote>();
  constructor(
    readonly policy: NotificationPolicy,
    readonly run: (command: string, args?: unknown) => Promise<unknown>,
    readonly error: (error: unknown) => void,
  ) {}
  registerChannel(channel: NotificationChannel): () => void {
    if (!channel.id || this.#channels.has(channel.id)) {
      throw new Error(`Duplicate or empty notification channel: ${channel.id}`);
    }
    this.#channels.set(channel.id, channel);
    return () => {
      if (this.#channels.get(channel.id) !== channel) return;
      this.retractChannel(channel.id);
      this.#channels.delete(channel.id);
    };
  }
  available(id: string): boolean {
    return this.#channels.get(id)?.available() ?? false;
  }
  current(note: Note): boolean {
    return this.#notes.get(note.id)?.note === note;
  }
  publish(input: Note): Note {
    return this.#publish(input, true);
  }
  #publish(input: Note, fresh: boolean): Note {
    this.retract(input.id);
    const note: Note = Object.freeze({
      ...input,
      detail: input.detail === undefined
        ? undefined
        : structuredClone(input.detail),
      sessionRef: input.sessionRef && Object.freeze({ ...input.sessionRef }),
      actions: Object.freeze(input.actions.map((action) =>
        Object.freeze({
          ...action,
          args: action.args === undefined
            ? undefined
            : structuredClone(action.args),
        })
      )),
    });
    const active: ActiveNote = {
      note,
      deliveries: new Map(),
      dismissed: new Set(),
    };
    this.#notes.set(note.id, active);
    this.#route(active, fresh);
    return note;
  }
  replace(previous: Note, input: Note): Note | undefined {
    return this.current(previous) ? this.#publish(input, false) : undefined;
  }
  retract(id: string): void {
    const active = this.#notes.get(id);
    if (!active) return;
    this.#notes.delete(id);
    for (const id of [...active.deliveries.keys()]) this.#dismiss(active, id);
  }
  retractChannel(id: string): void {
    for (const active of this.#notes.values()) this.#dismiss(active, id);
  }
  viewed(sidecar: string, session: string): void {
    for (const active of this.#notes.values()) {
      const ref = active.note.sessionRef;
      if (ref?.sidecar === sidecar && ref.session === session) {
        this.retract(active.note.id);
      }
    }
  }
  removeSidecar(sidecar: string): void {
    for (const active of this.#notes.values()) {
      if (active.note.sessionRef?.sidecar === sidecar) {
        this.retract(active.note.id);
      }
    }
  }
  /** Re-evaluate persistent presentation only; never replay sound on focus/prefs. */
  refresh(): void {
    for (const active of this.#notes.values()) this.#route(active, false);
  }
  stop(): void {
    for (const id of [...this.#notes.keys()]) this.retract(id);
  }
  #dismiss(active: ActiveNote, id: string): void {
    if (!active.deliveries.delete(id)) return;
    this.#channels.get(id)?.retract(active.note.id);
    if (
      !active.note.sessionRef && !active.deliveries.size &&
      this.#notes.get(active.note.id) === active
    ) {
      this.#notes.delete(active.note.id);
    }
  }
  #route(active: ActiveNote, fresh: boolean): void {
    const route = this.policy(active.note, (id) => this.available(id), fresh);
    for (const id of [...active.deliveries.keys()]) {
      if (!route.channels.includes(id)) this.#dismiss(active, id);
    }
    for (const id of route.channels) this.#deliver(active, id, route);
  }
  #deliver(active: ActiveNote, id: string, route: NotificationRoute): void {
    if (active.deliveries.has(id) || active.dismissed.has(id)) return;
    const channel = this.#channels.get(id);
    const fallback = () => {
      if (route.fallback?.from === id) {
        this.#deliver(active, route.fallback.to, { channels: [] });
      }
    };
    if (!channel?.available()) return fallback();
    const currentNote = () =>
      this.#notes.get(active.note.id) === active &&
      this.#channels.get(id) === channel;
    const current = () =>
      currentNote() &&
      active.deliveries.get(id) === delivery;
    const invoke = async (action: NoteAction, detached = false) => {
      if (
        !(detached ? currentNote() : current()) ||
        !active.note.actions.includes(action)
      ) return;
      try {
        await this.run(action.command, action.args);
      } catch (error) {
        this.error(error);
      }
      // Selection/resolution, not a click or a resolved promise, owns attention.
    };
    const delivery: NoteDelivery = {
      current,
      currentNote,
      dismiss: () => {
        if (current()) {
          active.dismissed.add(id);
          this.#dismiss(active, id);
        }
      },
      invoke: (action) => invoke(action),
      invokeDefault: async () => {
        const action = active.note.actions.find((action) => action.default);
        if (action) await invoke(action, true);
      },
      unavailable: () => {
        if (!current()) return;
        this.#dismiss(active, id);
        fallback();
      },
    };
    active.deliveries.set(id, delivery);
    try {
      channel.deliver(active.note, delivery);
    } catch {
      delivery.unavailable();
    }
  }
}
