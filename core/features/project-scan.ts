// SPDX-License-Identifier: LGPL-3.0-only
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  SEPARATOR,
} from "@std/path";
import { HarnessError } from "@otk/harness";
import { validateKey } from "@otk/store";
export const MAX_NATIVE_PATH = 4096;
export function projectPath(path: string): string {
  validateKey(path, {
    maxLength: MAX_NATIVE_PATH,
    blank: false,
    invalid: () => new HarnessError("params", "Invalid project path"),
  });
  return resolve(
    path.startsWith("~/") ? join(Deno.env.get("HOME")!, path.slice(2)) : path,
  );
}
export function pathTemplate(template: string): string {
  const path = projectPath(template);
  const parts = normalize(path).split(SEPARATOR);
  if (
    !isAbsolute(path) || parts.filter((p) => p === "{project}").length > 1 ||
    parts.some((p) => p !== "{project}" && /[{}*?]/.test(p))
  ) {
    throw new HarnessError(
      "params",
      "Use one {project} directory segment in a path template",
    );
  }
  return path;
}
/** Bounded template expansion, never a recursive walk of unrelated directories. */
export async function scanProjects(
  templates: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const found = new Set<string>();
  for (const template of templates) {
    signal?.throwIfAborted();
    const path = pathTemplate(template),
      parts = path.split(SEPARATOR),
      wildcard = parts.indexOf("{project}");
    let candidates = [path];
    try {
      if (wildcard >= 0) {
        const parent = parts.slice(0, wildcard).join(SEPARATOR) || SEPARATOR;
        candidates = [];
        for await (const child of Deno.readDir(parent)) {
          signal?.throwIfAborted();
          if (child.isDirectory) {
            candidates.push(
              join(parent, child.name, ...parts.slice(wildcard + 1)),
            );
          }
        }
      }
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        try {
          if (
            (await Deno.stat(candidate)).isDirectory &&
            !(await isWorktree(candidate))
          ) found.add(candidate);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return [...found].sort();
}

/** Git's linked-worktree metadata has commondir + a backlink, unlike submodules.
 * Read only these small files: no Git process or native backend instance. */
async function isWorktree(directory: string): Promise<boolean> {
  const dot = join(directory, ".git");
  try {
    if (!(await Deno.stat(dot)).isFile) return false;
    const match = /^gitdir:\s*(.+)\s*$/m.exec(await Deno.readTextFile(dot));
    if (!match) return false;
    const metadata = resolve(directory, match[1].trim());
    const common = (await Deno.readTextFile(join(metadata, "commondir")))
      .trim();
    const backlink = (await Deno.readTextFile(join(metadata, "gitdir"))).trim();
    return resolve(metadata, common) !== metadata &&
      resolve(dirname(join(metadata, "gitdir")), backlink) === dot;
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) return false;
    throw error;
  }
}
