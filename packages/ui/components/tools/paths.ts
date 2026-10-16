// SPDX-License-Identifier: LGPL-3.0-only
/** Display-only project-relative paths; commands, search expressions and URLs never enter here. */
export function relativeTarget(path: string, directory?: string): string {
  if (!directory || !path.startsWith("/") || !directory.startsWith("/")) {
    return path;
  }
  const segments = (value: string) => {
    const result: string[] = [];
    for (const part of value.split("/")) {
      if (part === "..") result.pop();
      else if (part && part !== ".") result.push(part);
    }
    return result;
  };
  const file = segments(path), root = segments(directory);
  let common = 0;
  while (
    common < file.length && common < root.length &&
    file[common] === root[common]
  ) common++;
  return [...root.slice(common).map(() => ".."), ...file.slice(common)].join(
    "/",
  ) || ".";
}
