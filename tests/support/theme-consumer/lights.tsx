// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, For } from "solid-js";
import {
  ActivityIndicator,
  ConnectionLight,
  LIGHT_STATES,
  type LightState,
  StatusLight,
} from "@otk/ui";
export default function Lights() {
  const [event, setEvent] = createSignal(0);
  return (
    <section aria-label="Independent indicator domains">
      <h1>Connection and session indicators</h1>
      <div
        data-theme-lamps
        style={{ display: "flex", gap: "32px", padding: "32px" }}
      >
        <For each={Object.keys(LIGHT_STATES) as LightState[]}>
          {(state) => (
            <div>
              <StatusLight state={state} event={event()} />
              <span>{state}</span>
            </div>
          )}
        </For>
        <StatusLight state="working" small />
      </div>
      <div
        data-theme-connections
        style={{ display: "flex", gap: "32px", padding: "32px" }}
      >
        <ConnectionLight
          connection={{
            label: "Fixture",
            status: "connected",
            harness: "connected",
          }}
        />
        <ConnectionLight
          connection={{
            label: "Fixture",
            status: "connecting",
            harness: "connecting",
          }}
        />
        <ConnectionLight
          connection={{
            label: "Fixture",
            status: "reconnecting",
            harness: "connected",
          }}
        />
        <ConnectionLight />
        <ConnectionLight
          connection={{
            label: "Fixture",
            status: "connected",
            harness: "connected",
            error: "Fixture error",
          }}
        />
        <ActivityIndicator small />
      </div>
      <button
        type="button"
        data-light-event
        onClick={() => setEvent(event() + 1)}
      >
        New event
      </button>
      <div>
        <For each={[0, 1, 2, 3]}>
          {(age) => (
            <span data-age={age} class={`otk-project-name otk-age-${age}`}>
              Age {age}
            </span>
          )}
        </For>
      </div>
    </section>
  );
}
