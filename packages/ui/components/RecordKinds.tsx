// SPDX-License-Identifier: LGPL-3.0-only
import {
  createContext,
  createMemo,
  createUniqueId,
  type Element,
  For,
  useContext,
} from "solid-js";
import { foldRecords, type RecordKindFold } from "@otk/client";
import type { Activity, DisclosureCategory, Preferences } from "@otk/protocol";
import { transcriptDisclosureIdentity } from "../features/transcript-context.tsx";
import ChromeMeta, { MetaItem, MetaRow } from "./ChromeMeta.tsx";
import Disclosure, { useDisclosureOwner } from "./Disclosure.tsx";

const RecordKindsRegion = createContext<string | null>(null);
export const useRecordKindsRegion = () =>
  useContext(RecordKindsRegion) ?? undefined;

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
    meta: () => Element,
  ): Element;
}): Element {
  const id = createUniqueId();
  const identify = transcriptDisclosureIdentity();
  const owner = useDisclosureOwner();
  const identity = (category: DisclosureCategory) =>
    identify({ owner: props.identity, category });
  const input = (category: DisclosureCategory) => ({
    category,
    prefs: () => props.prefs,
  });
  const folded = createMemo(() =>
    foldRecords(
      props.items,
      props.activity,
      (category) =>
        owner().bind("recordKinds", identity(category), input(category)).open(),
      props.count,
    )
  );
  const meta = () => (
    <MetaRow whole={!!(folded().folds.length || props.counts?.length)}>
      <For
        each={props.counts ?? []}
        keyed={(count) =>
          count.category}
      >
        {(count) => (
          <MetaItem rank={1}>
            <ChromeMeta data-record-kind={count().category}>
              {count().label}
            </ChromeMeta>
          </MetaItem>
        )}
      </For>
      <For
        each={folded().folds}
        keyed={(fold) => fold.category}
      >
        {(fold) => (
          <MetaItem rank={0} required>
            <Disclosure
              kind="recordKinds"
              identity={identity(fold().category)}
              input={input(fold().category)}
              variant="meta"
              label={fold().label}
              hasContent={() => true}
              controls={id}
              recordKind={fold().category}
            />
          </MetaItem>
        )}
      </For>
    </MetaRow>
  );
  return (
    <RecordKindsRegion value={id}>
      {props.render(() => folded().visible, meta)}
    </RecordKindsRegion>
  );
}
