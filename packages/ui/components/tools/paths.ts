// SPDX-License-Identifier: LGPL-3.0-only
import { relativePath } from "@otk/client";
import type { PathSemantics } from "@otk/protocol";
/** Display-only project-relative paths; commands, search expressions and URLs never enter here. */
export function relativeTarget(
  path: string,
  directory?: string,
  paths: PathSemantics = { style: "posix", separator: "/" },
): string {
  return relativePath(path, directory, paths);
}
