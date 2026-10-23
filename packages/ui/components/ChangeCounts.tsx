// SPDX-License-Identifier: LGPL-3.0-only
import "./ChangeCounts.css" with { type: "text" };
import type { Element } from "solid-js";

export default function ChangeCounts(
  props: { additions: number; deletions: number },
): Element {
  return (
    <>
      <span class="otk-diff-add">+{props.additions}</span>{" "}
      <span class="otk-diff-del">−{props.deletions}</span>
    </>
  );
}
