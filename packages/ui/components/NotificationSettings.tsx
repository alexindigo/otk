// SPDX-License-Identifier: LGPL-3.0-only
import "./NotificationSettings.css" with { type: "text" };
import { createSignal, onCleanup } from "solid-js";
import type { Preferences } from "@otk/protocol";
import PreferenceControls, {
  type PreferenceControlsProps,
} from "./PreferenceControls.tsx";
import type { BrowserNotificationStatus } from "../features/notify/os.ts";
export type NotificationPreference = Extract<
  keyof Preferences,
  `notify.${string}`
>;
export default function NotificationSettings(
  props: PreferenceControlsProps & {
    browser: {
      state: { status: BrowserNotificationStatus };
      subscribe(
        listener: (state: { status: BrowserNotificationStatus }) => void,
      ): () => void;
    };
  },
): import("solid-js").Element {
  const [status, setStatus] = createSignal(props.browser.state.status);
  onCleanup(props.browser.subscribe((state) => setStatus(state.status)));
  return (
    <section
      class="otk-notification-settings"
      aria-label="Notification settings"
    >
      <h2>Notifications</h2>
      <PreferenceControls {...props} group="notifications" />
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
    </section>
  );
}
