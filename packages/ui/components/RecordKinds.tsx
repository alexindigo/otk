// SPDX-License-Identifier: LGPL-3.0-only
import { createMemo, type Element, For } from "solid-js";
import { foldRecords } from "@otk/client";
import type { Activity, Preferences } from "@otk/protocol";
import { retainedRecordKinds } from "../features/transcript-context.tsx";
import ChromeMeta from "./ChromeMeta.tsx";

/** Both interval and work frames borrow this category disclosure owner. */
export default function RecordKinds<T>(props: {
  items: readonly T[];
  activity(item: T): Activity | undefined;
  count?(item: T): number;
  prefs: Preferences;
  identity: string;
  render(visible: () => T[], meta: () => Element): Element;
}): Element {
  const choices = retainedRecordKinds(() => props.identity);
  const folded = createMemo(() =>
    foldRecords(
      props.items,
      props.activity,
      (category) => choices.expanded(category, props.prefs),
      props.count,
    )
  );
  const meta = () => (
    <For each={folded().folds} keyed={(fold) => fold.category}>
      {(fold) => (
        <button
          type="button"
          data-record-kind={fold().category}
          aria-expanded={choices.expanded(fold().category, props.prefs)
            ? "true"
            : "false"}
          onClick={() =>
            choices.set(
              fold().category,
              !choices.expanded(fold().category, props.prefs),
            )}
        >
          <ChromeMeta>{fold().label}</ChromeMeta>
        </button>
      )}
    </For>
  );
  return props.render(() => folded().visible, meta);
}
