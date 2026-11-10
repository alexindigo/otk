// SPDX-License-Identifier: LGPL-3.0-only
import { extname } from "@std/path";
/** Native source paths, not model output wrappers, select source highlighting. */
export function fileLanguage(path: string): string | undefined {
  const extension = extname(path).slice(1);
  return ({
    mjs: "js",
    cjs: "js",
    py: "python",
    rs: "rust",
    sh: "bash",
  } as Record<string, string>)[extension] || extension || undefined;
}
