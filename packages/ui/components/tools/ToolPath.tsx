// SPDX-License-Identifier: LGPL-3.0-only
import { relativeTarget } from "./paths.ts";

/** File/directory labels use the same presenter as tool header targets. */
export default function ToolPath(
  props: { path: string; directory?: string },
): import("solid-js").Element {
  return (
    <span class="otk-path">{relativeTarget(props.path, props.directory)}</span>
  );
}
