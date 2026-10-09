// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import type { EditCall } from "../../../../protocol/content.ts";
import type { Preferences } from "../../../../protocol/prefs.ts";
import Diff from "../Diff.tsx";
import Diagnostics from "./Diagnostics.tsx";
export default function EditTool(
  props: { call: EditCall; prefs: Preferences; paneWidth: number },
) {
  return (
    <>
      <div class="otk-tool-summary">Edit {props.call.path}</div>
      <For each={props.call.files} keyed={false}>
        {(file) => (
          <Diff
            file={file()}
            style={props.prefs.diffStyle}
            wrap={props.prefs.diffWrap}
            paneWidth={props.paneWidth}
          />
        )}
      </For>
      <Diagnostics items={props.call.diagnostics} />
    </>
  );
}
