// SPDX-License-Identifier: LGPL-3.0-only
import { extname } from "@std/path";
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
