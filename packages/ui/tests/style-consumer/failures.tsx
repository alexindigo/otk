// SPDX-License-Identifier: LGPL-3.0-only
import { CommandHub, RequestFailure } from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import { createSignal, onCleanup } from "solid-js";
import { applicationNotifications } from "../../shell/notifications.ts";
import Toasts from "../../components/Toasts.tsx";

/** Controlled public failures, rendered by the shipped application notification owners. */
export default function Failures() {
  const notifications = applicationNotifications({
    commands: new CommandHub(),
    prefs: () => ({
      ...DEFAULT_PREFS,
      "notify.os": false,
      "notify.sound": false,
    }),
    selection: () => undefined,
    viewing: () => false,
    connection: () => {
      throw new Error("No connection is acquired by this scene");
    },
    entry: () => undefined,
    observeEntries: () => () => {},
    attention: () => {
      throw new Error("No native attention is acquired by this scene");
    },
  });
  const [count, setCount] = createSignal(0);
  onCleanup(
    notifications.toast.subscribe((state) => setCount(state.items.length)),
  );
  onCleanup(() => notifications.stop());
  let sequence = 0;
  const fail = (reason: string, id = `scene-${++sequence}`) =>
    notifications.error(
      new RequestFailure({
        code: "consumer.unregistered-failure",
        retry: "none",
        diagnosticID: id,
        facts: {
          action: "permission.list",
          target: {
            sidecarId: "local",
            sessionID: "opcv2-ses_scene",
            label: "Failure fixture",
          },
          reason,
          recovery: "Open the session to review the pending request",
        },
      }),
    );
  return (
    <>
      <p>Failures stay separate from requests needing input.</p>
      <output data-note-count={count()}>
        {count()} retained notification groups
      </output>
      <button
        type="button"
        onClick={() => {
          for (let n = 1; n <= 22; n++) {
            fail(
              "The native session was not found",
              `repeated-${n}`,
            );
          }
          fail("The native session was not found", "repeated-22");
        }}
      >
        Repeat failure
      </button>
      <button
        type="button"
        onClick={() => {
          for (let n = 1; n <= 4; n++) fail(`Distinct failure ${n}`);
          for (let n = 1; n <= 2; n++) {
            notifications.hub.publish({
              id: `input-${n}`,
              kind: "question",
              title: `Question ${n}`,
              sessionRef: { sidecar: "local", session: `opcv2-ses_input${n}` },
              actions: [],
            });
          }
        }}
      >
        Mixed notifications
      </button>
      <button
        type="button"
        onClick={() =>
          fail(
            "Complete reason: " + "A long native explanation. ".repeat(200) +
              "END OF REASON",
          )}
      >
        Long failure
      </button>
      <Toasts model={notifications.toast} onMore={() => {}} />
    </>
  );
}
