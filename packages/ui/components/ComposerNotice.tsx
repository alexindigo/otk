// SPDX-License-Identifier: LGPL-3.0-only
import "./ComposerNotice.css" with { type: "text" };
import type { Element } from "solid-js";
/** Shared joined notice frame; content and actions belong to its consumer. */
export default function ComposerNotice(props: { children: Element }): Element {
  return <div class="otk-composer-notice">{props.children}</div>;
}
