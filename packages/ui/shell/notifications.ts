// SPDX-License-Identifier: LGPL-3.0-only
import {
  commandFailureFacts,
  type CommandHub,
  type EntityStateStore,
  type EntryChanges,
  failureNote,
  LOCAL_SIDECAR,
  type Note,
  notificationFailure,
  NotificationHub,
  notificationPolicy,
  NotificationTriggers,
  oldestPermission,
  permissionNoteDetail,
  permissionVisible,
  requestIdle,
  type Selection,
  serverNote,
  type SidecarConnection,
  type SidecarState,
  storageFailureNote,
} from "@otk/client";
import type {
  FailureFacts,
  IndexEntry,
  Preferences,
  ServerFrame,
} from "@otk/protocol";
import { registerBadgeChannel } from "../features/notify/badge.ts";
import { registerOsChannel } from "../features/notify/os.ts";
import { registerSoundChannel } from "../features/notify/sound.ts";
import { registerToastChannel } from "../features/notify/toast.ts";

/** Retain delivery receipts, not a second copy of server continuity. */
export function serverNotifications(hub: NotificationHub) {
  const published = new Map<string, Note>();
  const remove = (id: string) => {
    const previous = published.get(id);
    if (!previous) return;
    published.delete(id);
    hub.retract(previous.id);
  };
  return {
    remove,
    update(list: readonly Pick<SidecarState, "id" | "label" | "continuity">[]) {
      const present = new Set<string>();
      for (const sidecar of list) {
        const { id } = sidecar;
        const note = serverNote(sidecar, id === LOCAL_SIDECAR);
        if (!note) continue;
        present.add(id);
        const previous = published.get(id);
        if (previous && previous.dismissalKey === note.dismissalKey) {
          if (previous.title === note.title && previous.body === note.body) {
            continue;
          }
          const next = hub.replace(previous, note);
          if (next) published.set(id, next);
        } else published.set(id, hub.publish(note));
      }
      for (const id of published.keys()) {
        if (!present.has(id)) remove(id);
      }
    },
  };
}

/** The application selects channels and supplies live host/selection/RPC ports. */
export function applicationNotifications(input: {
  commands: CommandHub;
  prefs(): Preferences;
  selection(): Selection | undefined;
  viewing(): boolean;
  transcript?(): boolean;
  connection(sidecar: string): SidecarConnection;
  entry(sidecar: string, session: string): IndexEntry | undefined;
  observeEntries(
    sidecar: string,
    listener: (changes: EntryChanges) => void,
  ): () => void;
  entities(sidecar: string): EntityStateStore;
}) {
  const context = () => {
    const selected = input.selection();
    return {
      focused: document.hasFocus(),
      visible: document.visibilityState === "visible",
      prefs: input.prefs(),
      open: selected && input.viewing() && input.transcript?.() !== false
        ? { sidecar: selected.sidecarId, session: selected.sessionID }
        : undefined,
      requests: selected && input.viewing()
        ? { sidecar: selected.sidecarId, session: selected.sessionID }
        : undefined,
      lookup: input.entry,
    };
  };
  let sequence = 0;
  const message = (title: string) =>
    hub.publish({
      id: `message/info/${++sequence}`,
      kind: "info",
      title,
      actions: [],
    });
  const fail = (error: unknown, facts?: FailureFacts) => {
    const note = failureNote(error, facts);
    if (note) hub.publish(note);
  };
  const target = (sidecarId: string, sessionID: string) => ({
    sidecarId,
    sessionID,
    label: input.entry(sidecarId, sessionID)?.title,
  });
  const hub = new NotificationHub(
    notificationPolicy(context),
    (id, args) => input.commands.run(id, args),
    (error, note, action) =>
      fail(error, {
        // The hub froze this originating action before invocation; never look
        // up a replacement command's public wording after it fails.
        ...commandFailureFacts({
          id: action?.command,
          title: action?.label ?? "Running notification action",
        }),
        target: note?.sessionRef
          ? target(note.sessionRef.sidecar, note.sessionRef.session)
          : undefined,
      }),
  );
  const toast = registerToastChannel(hub),
    os = registerOsChannel(hub),
    sound = registerSoundChannel(hub),
    stopBadge = registerBadgeChannel(hub);
  const candidates = new Map<string, Note>();
  const receipts = new Map<string, Note>();
  const publish = (incoming: Note, previous?: Note) => {
    if (candidates.get(incoming.id) !== incoming) return;
    const ref = incoming.sessionRef!;
    const receipt = previous ? receipts.get(incoming.id) : undefined;
    const delivered = previous
      ? receipt && hub.replace(receipt, incoming)
      : hub.publish(incoming);
    if (delivered) receipts.set(incoming.id, delivered);
    const ctx = context();
    if (
      ctx.focused && ctx.visible && ctx.open?.sidecar === ref.sidecar &&
      ctx.open.session === ref.session
    ) {
      hub.viewed(ref.sidecar, ref.session);
    }
  };
  const retract = (id: string) => {
    candidates.delete(id);
    receipts.delete(id);
    hub.retract(id);
  };
  const triggers = new NotificationTriggers(
    (incoming, previous) => {
      if (incoming.kind === "permission" || incoming.kind === "question") {
        const ref = incoming.sessionRef!;
        const idle = requestIdle(
          input.entry(ref.sidecar, ref.session)?.timeUpdated,
          Date.now(),
        );
        incoming = {
          ...incoming,
          context: idle.lead ? idle : undefined,
        };
      }
      candidates.set(incoming.id, incoming);
      const ref = incoming.sessionRef!;
      if (
        incoming.kind === "question" &&
        input.connection(ref.sidecar).supports("questions")
      ) {
        void input.connection(ref.sidecar).rpc.call("question.list", {
          sessionID: ref.session,
        }).then((requests) => {
          if (candidates.get(incoming.id) !== incoming) return;
          const request = incoming.dismissalKey
            ? requests.find((request) =>
              incoming.dismissalKey === `question/${request.id}`
            )
            : requests[0];
          if (!request) return retract(incoming.id);
          const idle = requestIdle(
            input.entry(ref.sidecar, request.sessionID)?.timeUpdated,
            Date.now(),
          );
          const enriched = {
            ...incoming,
            dismissalKey: `question/${request.id}`,
            context: idle.lead ? idle : undefined,
          };
          candidates.set(incoming.id, enriched);
          publish(enriched, previous);
        }, (error) => {
          if (candidates.get(incoming.id) !== incoming) return;
          publish(incoming, previous);
          fail(error, {
            action: "question.list",
            target: target(ref.sidecar, ref.session),
          });
        });
        return;
      }
      if (
        incoming.kind !== "permission" ||
        !input.connection(ref.sidecar).supports("permissions")
      ) {
        publish(incoming, previous);
        return;
      }
      // Resolve action ownership before channel delivery. This schedules the input
      // tone once and constructs one OS note, without an enrichment replay.
      void input.connection(ref.sidecar).rpc.call(
        "permission.list",
        { sessionID: ref.session },
      ).then((requests) => {
        if (candidates.get(incoming.id) !== incoming) return;
        const request = oldestPermission(
          requests.filter((request) =>
            permissionVisible(
              input.entities(ref.sidecar),
              request.sessionID,
              request.id,
            ) &&
            (!incoming.dismissalKey ||
              incoming.dismissalKey === `permission/${request.id}`)
          ),
          ref.session,
          (id) => input.entry(ref.sidecar, id),
        );
        if (!request) {
          retract(incoming.id);
          return;
        }
        const idle = requestIdle(
          input.entry(ref.sidecar, request.sessionID)?.timeUpdated,
          Date.now(),
        );
        const enriched: Note = request
          ? {
            ...incoming,
            dismissalKey: `permission/${request.id}`,
            context: idle.lead ? idle : undefined,
            detail: permissionNoteDetail(request),
            actions: [...incoming.actions, {
              label: "Allow once",
              description: idle.resume,
              command: "permission.reply",
              args: {
                sidecarId: ref.sidecar,
                sessionID: request.sessionID,
                requestID: request.id,
                reply: "once",
              },
            }],
          }
          : incoming;
        candidates.set(incoming.id, enriched);
        publish(enriched, previous);
      }, (error) => {
        if (candidates.get(incoming.id) !== incoming) return;
        publish(incoming, previous);
        fail(error, {
          action: "permission.list",
          target: target(ref.sidecar, ref.session),
        });
      });
    },
    retract,
    undefined,
    undefined,
    undefined,
  );
  const update = () => {
    os.refresh();
    const ctx = context();
    if (ctx.focused && ctx.visible) {
      hub.retractChannel("os");
      if (ctx.open) {
        for (const [id, note] of candidates) {
          if (
            note.dismissOnView !== false &&
            note.sessionRef?.sidecar === ctx.open.sidecar &&
            note.sessionRef.session === ctx.open.session
          ) {
            candidates.delete(id);
            receipts.delete(id);
          }
        }
        hub.viewed(ctx.open.sidecar, ctx.open.session);
      }
    }
    hub.refresh();
  };
  const observed = new Map<string, () => void>();
  const servers = serverNotifications(hub);
  return {
    hub,
    toast: toast.model,
    os,
    update,
    info: (text: string) => message(text),
    error: fail,
    servers: servers.update,
    receive(sidecar: string, frame: ServerFrame) {
      if (!observed.has(sidecar)) {
        observed.set(
          sidecar,
          input.observeEntries(
            sidecar,
            (changes) => triggers.entriesChanged(sidecar, changes),
          ),
        );
      }
      if (frame.t === "welcome") {
        triggers.reset(sidecar);
        hub.removeSidecar(sidecar, (note) => !!notificationFailure(note));
      }
      if (frame.t === "error") {
        fail(frame, {
          actionLabel: "Receiving server update",
          target: { sidecarId: sidecar },
          reason: frame.message || frame.code,
        });
      }
      if (frame.t === "storage") {
        const note = storageFailureNote(sidecar, frame.state);
        if (note) hub.publish(note);
        else hub.retract(`storage/${sidecar}`);
      }
    },
    remove(sidecar: string) {
      servers.remove(sidecar);
      hub.retract(`storage/${sidecar}`);
      observed.get(sidecar)?.();
      observed.delete(sidecar);
      triggers.reset(sidecar);
      hub.removeSidecar(sidecar);
    },
    start() {
      const stopSound = sound.start();
      globalThis.addEventListener("focus", update);
      globalThis.addEventListener("blur", update);
      document.addEventListener("visibilitychange", update);
      update();
      return () => {
        stopSound();
        globalThis.removeEventListener("focus", update);
        globalThis.removeEventListener("blur", update);
        document.removeEventListener("visibilitychange", update);
      };
    },
    stop() {
      triggers.stop();
      for (const stop of observed.values()) stop();
      observed.clear();
      candidates.clear();
      receipts.clear();
      servers.update([]);
      hub.stop();
      toast.stop();
      os.stop();
      sound.stop();
      stopBadge();
    },
  };
}
