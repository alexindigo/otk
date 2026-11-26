// SPDX-License-Identifier: LGPL-3.0-only
import type { ForkNote as Note } from "@otk/client";
import ComposerNotice, { ComposerNoticeRow } from "./ComposerNotice.tsx";
import { CloseIcon, ForkIcon } from "./ChromeIcons.tsx";
export default function ForkNote(props: { note: Note; onDismiss(): void }) {
  return (
    <ComposerNotice>
      <ForkFact {...props} />
    </ComposerNotice>
  );
}
export function ForkFact(
  props: { note: Note; onDismiss(): void },
): import("solid-js").Element {
  return (
    <ComposerNoticeRow
      class="otk-fork-note"
      icon={ForkIcon}
      actions={[{
        key: "dismiss",
        label: "Dismiss fork note",
        title: "Dismiss fork note",
        icon: CloseIcon,
        run: props.onDismiss,
      }]}
    >
      <span
        class="otk-control-label otk-control-grow"
        title={`Forked from “${props.note.from}”. Files are shared with the original.`}
      >
        Forked from “{props.note.from}”. Files are shared with the original.
      </span>
    </ComposerNoticeRow>
  );
}
