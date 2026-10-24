// SPDX-License-Identifier: LGPL-3.0-only
import "./VisualSettings.css" with { type: "text" };
import PreferenceControls, {
  type PreferenceControlsProps,
} from "./PreferenceControls.tsx";
export default function VisualSettings(
  props: PreferenceControlsProps,
): import("solid-js").Element {
  return (
    <section class="otk-visual-settings" aria-label="Appearance settings">
      <h2>Appearance</h2>
      <PreferenceControls {...props} group="appearance" />
      <p class="otk-muted">
        Reduced colours uses status shapes and underlines. Animations also stop
        when your system requests reduced motion.
      </p>
    </section>
  );
}
