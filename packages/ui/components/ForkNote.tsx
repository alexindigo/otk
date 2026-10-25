// SPDX-License-Identifier: LGPL-3.0-only
import type { ForkNote as Note } from "@otk/client";
import ComposerNotice from "./ComposerNotice.tsx";
import { CloseIcon, ForkIcon } from "./ChromeIcons.tsx";
export default function ForkNote(props: { note: Note; onDismiss(): void }) {
  return (
    <ComposerNotice>
      <div class="otk-fork-note">
        <ForkIcon />
        <span>
          Forked from “{props.note.from}”. Files are shared with the original.
        </span>
        <button
          type="button"
          class="otk-icon-button"
          aria-label="Dismiss fork note"
          title="Dismiss fork note"
          onClick={() => props.onDismiss()}
        >
          <CloseIcon />
        </button>
      </div>
    </ComposerNotice>
  );
}
