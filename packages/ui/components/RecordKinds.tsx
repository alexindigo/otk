// SPDX-License-Identifier: LGPL-3.0-only
import { createMemo, type Element } from "solid-js";
import { foldRecords, type RecordKindFold } from "@otk/client";
import type { Activity, Preferences } from "@otk/protocol";
import { retainedRecordKinds } from "../features/transcript-context.tsx";
import ChromeMeta, { MetaRow } from "./ChromeMeta.tsx";
import DisclosureToggle from "./DisclosureToggle.tsx";

/** Both interval and work frames borrow this category disclosure owner. */
export default function RecordKinds<T>(props: {
  items: readonly T[];
  activity(item: T): Activity | undefined;
  count?(item: T): number;
  counts?: readonly RecordKindFold[];
  prefs: Preferences;
  identity: string;
  render(
    visible: () => T[],
    meta: (primary: () => Element) => Element,
  ): Element;
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
  const meta = (primary: () => Element) => (
    <MetaRow
      controls={[
        ...(props.counts ?? []).map((count) => ({
          key: count.category,
          measure: () => <ChromeMeta>{count.label}</ChromeMeta>,
          render: () => (
            <ChromeMeta data-record-kind={count.category}>
              {count.label}
            </ChromeMeta>
          ),
        })),
        ...folded().folds.map((fold) => ({
          key: fold.category,
          measure: () => (
            <DisclosureToggle
              variant="meta"
              label={fold.label}
              onOpen={() => {}}
            >
              <ChromeMeta>{fold.label}</ChromeMeta>
            </DisclosureToggle>
          ),
          render: () => (
            <DisclosureToggle
              variant="meta"
              label={fold.label}
              data-record-kind={fold.category}
              open={choices.expanded(fold.category, props.prefs)}
              onOpen={(open) =>
                choices.set(
                  fold.category,
                  open,
                )}
            >
              <ChromeMeta>{fold.label}</ChromeMeta>
            </DisclosureToggle>
          ),
        })),
      ]}
    >
      {primary()}
    </MetaRow>
  );
  return props.render(() => folded().visible, meta);
}
