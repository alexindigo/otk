// SPDX-License-Identifier: LGPL-3.0-only
import { relativeTarget } from "./paths.ts";
import { usePathSemantics } from "../PathProvider.tsx";

/** File/directory labels use the same presenter as tool header targets. */
export default function ToolPath(
  props: { path: string; directory?: string },
): import("solid-js").Element {
  const paths = usePathSemantics();
  return (
    <span class="otk-path">
      {relativeTarget(props.path, props.directory, paths())}
    </span>
  );
}
