// SPDX-License-Identifier: LGPL-3.0-only
import { createMemo, type Element, For } from "solid-js";
import { foldRecords } from "@otk/client";
import type { Activity, Preferences } from "@otk/protocol";
import { retainedRecordKinds } from "../features/transcript-context.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import DisclosureToggle from "./DisclosureToggle.tsx";

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
        <DisclosureToggle
          variant="meta"
          label={fold().label}
          data-record-kind={fold().category}
          open={choices.expanded(fold().category, props.prefs)}
          onOpen={(open) =>
            choices.set(
              fold().category,
              open,
            )}
        >
          <ChromeMeta truncate>{fold().label}</ChromeMeta>
        </DisclosureToggle>
      )}
    </For>
  );
  return props.render(() => folded().visible, meta);
}
