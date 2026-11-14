// SPDX-License-Identifier: LGPL-3.0-only
import "./DisplayMenu.css" with { type: "text" };
import { Show } from "solid-js";
import PreferenceControls, {
  type PreferenceControlsProps,
} from "./PreferenceControls.tsx";
import { SettingsIcon } from "./ChromeIcons.tsx";
import Popover from "./surface/Popover.tsx";
import { errorFeedback, type FailureValue } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
export interface DisplayMenuProps extends PreferenceControlsProps {
  error: string | FailureValue;
}
export default function DisplayMenu(
  props: DisplayMenuProps,
): import("solid-js").Element {
  return (
    <Popover
      class="otk-display-menu"
      triggerClass="otk-display-trigger"
      label="Display options"
      title="Display preferences"
      trigger={<SettingsIcon />}
    >
      <DisplayPreferences {...props} />
    </Popover>
  );
}

/** Identical preference controls in the anchored menu and app-level dialog. */
export function DisplayPreferences(
  props: DisplayMenuProps,
): import("solid-js").Element {
  return (
    <div class="otk-display-preferences">
      <PreferenceControls {...props} />
      <Show when={props.error}>
        <FeedbackStatus
          feedback={errorFeedback(props.error, {
            action: "Saving display preferences",
          })}
        />
      </Show>
    </div>
  );
}
