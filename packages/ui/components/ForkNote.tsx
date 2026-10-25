// SPDX-License-Identifier: LGPL-3.0-only
import type { ForkNote as Note } from "@otk/client";
import ComposerNotice, { ComposerNoticeRow } from "./ComposerNotice.tsx";
import { CloseIcon, ForkIcon } from "./ChromeIcons.tsx";
export default function ForkNote(props: { note: Note; onDismiss(): void }) {
  return (
    <ComposerNotice>
      <ComposerNoticeRow
        class="otk-fork-note"
        icon={<ForkIcon />}
        trailing={
          <button
            type="button"
            class="otk-icon-button"
            aria-label="Dismiss fork note"
            title="Dismiss fork note"
            onClick={() => props.onDismiss()}
          >
            <CloseIcon />
          </button>
        }
      >
        <span
          class="otk-control-label otk-control-grow"
          title={`Forked from “${props.note.from}”. Files are shared with the original.`}
        >
          Forked from “{props.note.from}”. Files are shared with the original.
        </span>
      </ComposerNoticeRow>
    </ComposerNotice>
  );
}
