// SPDX-License-Identifier: LGPL-3.0-only
import {
  type CommandHub,
  type Note,
  NotificationHub,
  notificationPolicy,
  NotificationTriggers,
  oldestPermission,
  type Selection,
  type SidecarConnection,
} from "@otk/client";
import type { IndexEntry, Preferences, ServerFrame } from "@otk/protocol";
import { registerBadgeChannel } from "../features/notify/badge.ts";
import { registerOsChannel } from "../features/notify/os.ts";
import { registerSoundChannel } from "../features/notify/sound.ts";
import { registerToastChannel } from "../features/notify/toast.ts";
/** The application selects channels and supplies live host/selection/RPC ports. */
export function applicationNotifications(input: {
  commands: CommandHub;
  prefs(): Preferences;
  selection(): Selection | undefined;
  viewing(): boolean;
  connection(sidecar: string): SidecarConnection;
  entry(sidecar: string, session: string): IndexEntry | undefined;
}) {
  const context = () => {
    const selected = input.selection();
    return {
      focused: document.hasFocus(),
      visible: document.visibilityState === "visible",
      prefs: input.prefs(),
      open: selected && input.viewing()
        ? {
          sidecar: selected.sidecarId,
          session: selected.rootID || selected.sessionID,
        }
        : undefined,
    };
  };
  let sequence = 0;
  const message = (kind: "error" | "info", title: string) =>
    hub.publish({
      id: kind === "info" ? "message/info" : `message/error/${++sequence}`,
      kind,
      title,
      actions: [],
    });
  const hub = new NotificationHub(
    notificationPolicy(context),
    (id, args) => input.commands.run(id, args),
    (error) => message("error", (error as Error).message),
  );
  const toast = registerToastChannel(hub),
    os = registerOsChannel(hub),
    sound = registerSoundChannel(hub),
    stopBadge = registerBadgeChannel(hub);
  const candidates = new Map<string, Note>();
  const publish = (incoming: Note) => {
    if (candidates.get(incoming.id) !== incoming) return;
    const ref = incoming.sessionRef!;
    hub.publish(incoming);
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
    hub.retract(id);
  };
  const triggers = new NotificationTriggers((incoming) => {
    candidates.set(incoming.id, incoming);
    const ref = incoming.sessionRef!;
    if (
      incoming.kind !== "permission" ||
      !input.connection(ref.sidecar).supports("permissions")
    ) {
      publish(incoming);
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
        requests,
        ref.session,
        (id) => input.entry(ref.sidecar, id),
      );
      const enriched: Note = request
        ? {
          ...incoming,
          actions: [...incoming.actions, {
            label: "Allow once",
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
      publish(enriched);
    }, (error) => {
      if (candidates.get(incoming.id) !== incoming) return;
      publish(incoming);
      message("error", (error as Error).message);
    });
  }, retract);
  const update = () => {
    os.refresh();
    const ctx = context();
    if (ctx.focused && ctx.visible) {
      hub.retractChannel("os");
      if (ctx.open) {
        for (const [id, note] of candidates) {
          if (
            note.sessionRef?.sidecar === ctx.open.sidecar &&
            note.sessionRef.session === ctx.open.session
          ) candidates.delete(id);
        }
        hub.viewed(ctx.open.sidecar, ctx.open.session);
      }
    }
    hub.refresh();
  };
  return {
    hub,
    toast: toast.model,
    os,
    update,
    info: (text: string) => message("info", text),
    error: (error: unknown) => message("error", (error as Error).message),
    receive(sidecar: string, frame: ServerFrame) {
      if (frame.t === "welcome") {
        triggers.reset(sidecar);
        hub.removeSidecar(sidecar);
      }
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        triggers
          .receive(sidecar, frame);
      }
      if (frame.t === "rpc.result" && !frame.ok) {
        message(
          "error",
          frame.error.message,
        );
      }
      if (frame.t === "error") message("error", frame.message || frame.code);
    },
    remove(sidecar: string) {
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
      candidates.clear();
      hub.stop();
      toast.stop();
      os.stop();
      sound.stop();
      stopBadge();
    },
  };
}
