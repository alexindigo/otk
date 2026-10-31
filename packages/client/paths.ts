// SPDX-License-Identifier: LGPL-3.0-only
import type { PathSemantics } from "@otk/protocol";
type Path = {
  root: string;
  parts: string[];
  absolute: boolean;
  trailing: boolean;
};
const uri = (value: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
function parse(value: string, paths: PathSemantics): Path {
  const win = paths.style === "win32", separator = paths.separator;
  const text = win ? value.replaceAll("/", "\\") : value;
  const unc = win ? /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.exec(text) : null;
  const drive = win ? /^[a-z]:/i.exec(text) : null;
  const root = unc
    ? unc[0].replace(/\\$/, "") + separator
    : drive
    ? drive[0] + (text[2] === separator ? separator : "")
    : text.startsWith(separator)
    ? separator
    : "";
  const absolute = !!unc || root.endsWith(separator);
  const parts: string[] = [];
  for (const part of text.slice(root.length).split(separator)) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  return { root, parts, absolute, trailing: text.endsWith(separator) };
}
function print(value: Path, paths: PathSemantics): string {
  const result = value.root + value.parts.join(paths.separator);
  return (result || ".") +
    (value.trailing && value.parts.length ? paths.separator : "");
}
/** Resolve lexical relative references; URI decoding and access belong to the server. */
export function canonicalPath(
  value: string,
  directory: string,
  paths: PathSemantics,
): string {
  if (uri(value)) return value;
  const target = parse(value, paths), base = parse(directory, paths);
  if (
    paths.style === "win32" && target.root === "\\" &&
    /^[a-z]:/i.test(base.root)
  ) {
    target.root = base.root.slice(0, 2) + "\\";
    return print(target, paths);
  }
  if (target.absolute) return print(target, paths);
  if (
    target.root &&
    target.root.toLowerCase() !== base.root.slice(0, 2).toLowerCase()
  ) return value;
  return print(
    parse(
      print(base, paths).replace(/[\\/]$/, "") + paths.separator +
        (target.root ? value.slice(target.root.length) : value),
      paths,
    ),
    paths,
  );
}
/** Keep outside-project paths absolute and spelling intact. */
export function relativePath(
  value: string,
  directory: string | undefined,
  paths: PathSemantics,
): string {
  if (!directory || uri(value)) return value;
  const target = parse(value, paths), base = parse(directory, paths);
  if (!target.absolute || !base.absolute) return value;
  const key = (value: string) =>
    paths.style === "win32" ? value.toLowerCase() : value;
  if (
    key(target.root) !== key(base.root) ||
    base.parts.some((part, i) => key(part) !== key(target.parts[i] ?? ""))
  ) return value;
  return target.parts.slice(base.parts.length).join(paths.separator) +
      (target.trailing && target.parts.length > base.parts.length
        ? paths.separator
        : "") || ".";
}
