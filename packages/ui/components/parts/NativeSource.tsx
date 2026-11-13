// SPDX-License-Identifier: LGPL-3.0-only
import "../tools/ToolFrame.css" with { type: "text" };
import "./NativeSource.css" with { type: "text" };
import { Show } from "solid-js";
import type { Preferences } from "@otk/protocol";
import { retainedDisclosure } from "../../features/transcript-context.tsx";
import { ChevronIcon } from "../ChromeIcons.tsx";

/** Source inspection has its own identity-scoped choice and category default. */
export default function NativeSource(props: {
  preview: { text: string; bytes: number; truncated: boolean };
  prefs: Preferences;
}): import("solid-js").Element {
  const [open, setOpen] = retainedDisclosure(
    "source",
    "source",
    () => props.prefs,
  );
  return (
    <section class={["otk-tool-line otk-native-source", { "is-open": open() }]}>
      <button
        type="button"
        class="otk-tool-toggle"
        aria-expanded={open() ? "true" : "false"}
        onClick={() =>
          setOpen(!open())}
      >
        <span class="otk-tool-icon" aria-hidden="true">
          <ChevronIcon />
        </span>
        <span class="otk-control-label">Source</span>
      </button>
      <Show when={open()}>
        <div class="otk-tool-body">
          <small class="otk-muted">
            {props.preview.bytes}{" "}
            bytes{props.preview.truncated ? " - Preview truncated" : ""}
          </small>
          <pre class="otk-native-preview">{props.preview.text}</pre>
        </div>
      </Show>
    </section>
  );
}
