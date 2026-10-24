// SPDX-License-Identifier: LGPL-3.0-only
import { type Element, For } from "solid-js";
import type { FileDiff, Preferences } from "@otk/protocol";
import Diff from "../Diff.tsx";
/** One collection presentation; tool owners supply only inline-label policy and
 * any trailing content, without knowing the Diff renderer's input plumbing. */
export default function FileChanges(props: {
  files: FileDiff[];
  prefs: Preferences;
  paneWidth: number;
  directory?: string;
  inline(file: FileDiff): boolean;
  children?: Element;
}): Element {
  return (
    <>
      <For each={props.files} keyed={false}>
        {(file) => (
          <Diff
            file={file()}
            inline={props.inline(file())}
            style={props.prefs.diffStyle}
            wrap={props.prefs.diffWrap}
            paneWidth={props.paneWidth}
            directory={props.directory}
          />
        )}
      </For>
      {props.children}
    </>
  );
}
