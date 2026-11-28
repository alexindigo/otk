// SPDX-License-Identifier: LGPL-3.0-only
/** A filename selects its source highlighting language. */
export function fileLanguage(path: string): string | undefined {
  const name = path.replace(/[/\\]+$/, "").split(/[/\\]/).at(-1)!;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return ({
    mjs: "js",
    cjs: "js",
    py: "python",
    rs: "rust",
    sh: "bash",
  } as Record<string, string>)[extension] || extension || undefined;
}
