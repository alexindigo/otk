// SPDX-License-Identifier: LGPL-3.0-only
import "./TranscriptSettings.css" with { type: "text" };
import PreferenceControls, {
  type PreferenceControlsProps,
} from "./PreferenceControls.tsx";

export default function TranscriptSettings(
  props: PreferenceControlsProps,
): import("solid-js").Element {
  return (
    <section class="otk-transcript-settings" aria-label="Transcript settings">
      <h2>Transcript</h2>
      <p>
        Expansion settings control defaults. Your choices on individual rows
        stay unchanged.
      </p>
      <PreferenceControls {...props} group="transcript" />
      <section aria-label="Tool visibility">
        <h3>Tool visibility</h3>
        <PreferenceControls {...props} group="transcript-visibility" />
      </section>
    </section>
  );
}
