// SPDX-License-Identifier: LGPL-3.0-only
import type { TranscriptGapState } from "@otk/client";
import type { Element } from "solid-js";
import { GapIcon } from "./ChromeIcons.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import RecordRow from "./RecordRow.tsx";
import { TreeIcon } from "./Tree.tsx";
import "./TranscriptGap.css" with { type: "text" };

const labels = {
  idle: "Earlier messages not loaded",
  loading: "Loading earlier messages...",
  failed: "Couldn't load earlier messages",
} as const;

export default function TranscriptGap(props: {
  gap: () => TranscriptGapState;
  onLoad(): void;
}): Element {
  const state = () => props.gap().state;
  const failed = () => state() === "failed";
  const loading = () => state() === "loading";
  return (
    <div
      class="otk-transcript-gap"
      role="status"
      aria-busy={loading() ? "true" : "false"}
    >
      <RecordRow
        icon={() => (
          <TreeIcon>
            <GapIcon />
          </TreeIcon>
        )}
        failed={failed()}
        actions={loading() ? [] : [{
          key: "bridge",
          label: failed() ? "Retry" : "Load",
          title: failed()
            ? "Retry loading earlier messages"
            : "Load earlier messages",
          run: props.onLoad,
        }]}
      >
        <ChromeMeta truncate title={labels[state()]}>
          {labels[state()]}
        </ChromeMeta>
        <span class="otk-transcript-gap-rule" aria-hidden="true" />
      </RecordRow>
    </div>
  );
}
