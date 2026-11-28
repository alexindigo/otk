// SPDX-License-Identifier: LGPL-3.0-only
import {
  CommandHub,
  createEntityStateStore,
  globalAttention,
  presentedEntity,
  RequestFailure,
} from "@otk/client";
import { DEFAULT_PREFS, entityKey, type EntityState } from "@otk/protocol";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { applicationNotifications } from "../../shell/notifications.ts";
import Toasts from "../../components/Toasts.tsx";
import { useDisclosures } from "../../components/Disclosure.tsx";

/** Controlled public failures, rendered by the shipped application notification owners. */
export default function Failures() {
  const [state, setState] = createSignal<Record<string, EntityState>>({});
  const entities = createEntityStateStore({ read: state });
  const notifications = applicationNotifications({
    disclosures: useDisclosures(),
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
    entities: () => entities,
  });
  // D81: badge paint consumes published attention, never toast deliveries.
  createEffect(() => globalAttention([entities]), notifications.badge);
  onCleanup(() => entities.stop());
  const [count, setCount] = createSignal(0);
  onCleanup(
    notifications.toast.subscribe((state) => setCount(state.items.length)),
  );
  onCleanup(() => notifications.stop());
  let sequence = 0;
  let burst = 0;
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
          const run = ++burst;
          for (let n = 1; n <= 22; n++) {
            fail(
              "The native session was not found",
              `repeated-${run}-${n}`,
            );
          }
          fail("The native session was not found", `repeated-${run}-22`);
        }}
      >
        Repeat failure
      </button>
      <button
        type="button"
        onClick={() => {
          const questions = ["opcv2-ses_input1", "opcv2-ses_input2"];
          const global = presentedEntity("global", "global", "blocked");
          setState({
            [entityKey("global", "global")]: {
              ...global,
              counts: { ...global.counts, blocked: questions.length },
            },
          });
          for (let n = 1; n <= 4; n++) fail(`Distinct failure ${n}`);
          for (const [index, session] of questions.entries()) {
            const n = index + 1;
            notifications.hub.publish({
              id: `input-${n}`,
              kind: "question",
              title: `Question ${n}`,
              sessionRef: { sidecar: "local", session },
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
