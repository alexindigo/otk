// SPDX-License-Identifier: LGPL-3.0-only
import "./NotificationSettings.css" with { type: "text" };
import { createSignal, For, onCleanup, Show } from "solid-js";
import { type Preferences, preferences } from "@otk/protocol";
import type { BrowserNotificationStatus } from "../features/notify/os.ts";
export type NotificationPreference = Extract<
  keyof Preferences,
  `notify.${string}`
>;
export default function NotificationSettings(props: {
  prefs: Preferences;
  ready: boolean;
  browser: {
    state: { status: BrowserNotificationStatus };
    subscribe(
      listener: (state: { status: BrowserNotificationStatus }) => void,
    ): () => void;
  };
  onSet(key: NotificationPreference, value: boolean): Promise<void>;
}): import("solid-js").Element {
  const [status, setStatus] = createSignal(props.browser.state.status),
    [error, setError] = createSignal("");
  onCleanup(props.browser.subscribe((state) => setStatus(state.status)));
  return (
    <section
      class="otk-notification-settings"
      aria-label="Notification settings"
    >
      <h2>Notifications</h2>
      <For
        each={preferences.list().filter((
          definition,
        ): definition is import("@otk/protocol").PreferenceDefinition<
          NotificationPreference
        > => definition.key.startsWith("notify."))}
      >
        {(row) => (
          <label>
            <input
              type="checkbox"
              name={row.key}
              checked={props.prefs[row.key]}
              disabled={!props.ready}
              onChange={(event) => {
                setError("");
                void props.onSet(row.key, event.currentTarget.checked).catch((
                  error,
                ) => setError((error as Error).message));
              }}
            />
            <span>{row.label}</span>
          </label>
        )}
      </For>
      <p class="otk-notification-browser" role="status">
        {status() === "granted"
          ? "Browser permission granted"
          : status() === "denied"
          ? "Blocked by browser — in-page messages continue"
          : status() === "unavailable"
          ? "Browser notifications unavailable — in-page messages continue"
          : "Browser permission not granted"}
      </p>
      <p class="otk-muted">
        Sound unlocks after your first click or keypress. Preferences are saved
        on this host.
      </p>
      <Show when={error()}>
        <p class="otk-error" role="alert">{error()}</p>
      </Show>
    </section>
  );
}
