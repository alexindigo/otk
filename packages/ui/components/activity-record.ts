// SPDX-License-Identifier: LGPL-3.0-only
import type { ActivityGroup } from "@otk/client";
import { type Element, Show } from "solid-js";

export function activityRecord(
  entry: () => ActivityGroup,
  leaf: (id: string) => Element,
  group: () => Element,
): Element {
  // Record metadata is republished independently of its mounted leaf. Its
  // canonical member ID, not the entry object, defines the leaf's lifetime.
  return Show({
    keyed: true,
    get when() {
      const record = entry();
      return record.count ? undefined : record.members[0];
    },
    children: leaf,
    get fallback() {
      return group();
    },
  });
}
