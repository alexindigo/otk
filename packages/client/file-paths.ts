// SPDX-License-Identifier: LGPL-3.0-only
import {
  type FileFactFound,
  type Inline,
  isSessionID,
  type PathSemantics,
  sessionIDQualifier,
} from "@otk/protocol";
import { formatBytes } from "./format.ts";

export type PathMention = {
  raw: string;
  path: string;
  line?: { start: number; end: number };
};
export type SessionMention = { raw: string; sessionID: string };
export type InlineMention = PathMention | SessionMention;
export type PathSegment = { text: string; mention?: InlineMention };
type Where = "prose" | "code";
type TextContext = Where | "prompt";
type PathStyle = PathSemantics["style"];

/** Native IDs in a reply use the reply's provider namespace. */
export function sessionMentionID(
  id: string,
  from?: string,
): string | undefined {
  if (isSessionID(id)) return id;
  if (from && isSessionID(from)) {
    return from.slice(0, from.indexOf("-") + 1) + id;
  }
}

export function textRuns(items: readonly Inline[]): readonly Inline[] {
  const runs: Inline[] = [];
  for (const item of items) {
    const previous = runs.at(-1);
    if (item.i === "text" && previous?.i === "text") {
      runs[runs.length - 1] = { i: "text", text: previous.text + item.text };
    } else runs.push(item);
  }
  return runs;
}

const MAX_CANDIDATE = 1024;
const MAX_REMEMBERED = 1024;
const character = String.raw`[\p{L}\p{N}\p{M}._+@%=,~/\-]`;
const characters = new RegExp(`^${character}+$`, "u");
const position =
  /(?::([0-9]+)(?::([0-9]+)|-([0-9]+))?|#L([0-9]+)(?:-L([0-9]+))?)$/;
// Both native versions generate 12 lowercase hex digits and 14 base62 digits.
const sessionID = `(?:${sessionIDQualifier})?ses_[0-9a-f]{12}[0-9A-Za-z]{14}`;
const sessionToken = new RegExp(`^${sessionID}$`);
const candidates = new RegExp(
  String
    .raw`(?<![\p{L}\p{N}\p{M}_/])(?<session>${sessionID})(?![\p{L}\p{N}\p{M}_/])|(?:^|(?<=[\s(["'<]))~?/${character}*(?::\d+(?::\d+|-\d+)?|#L\d+(?:-L\d+)?)?`,
  "gu",
);
const promptCandidates = new RegExp(
  "`(?<quoted>[^`\\r\\n]+)`|" + candidates.source,
  "gu",
);
const scheme = /^[a-z][a-z0-9+.-]*:/i;
const rooted = /^(?:\/|~\/|\.\.?\/)/;
const extension = /[^.][.]([^.\/]+)$/;
const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function splitPosition(raw: string): PathMention | undefined {
  const suffix = position.exec(raw);
  if (!suffix) return { raw, path: raw };
  const start = Number(suffix[1] ?? suffix[4]);
  const end = Number(suffix[3] ?? suffix[5] ?? start);
  const column = Number(suffix[2] ?? 1);
  if (
    ![start, end, column].every(Number.isSafeInteger) || start < 1 ||
    end < start || column < 1
  ) return;
  return { raw, path: raw.slice(0, suffix.index), line: { start, end } };
}

// Markdown context determines which lexical shapes are worth a file check.
const forms: Record<Where, (path: string, hasLine: boolean) => boolean> = {
  prose: (path) =>
    path.startsWith("~/") ||
    (path.startsWith("/") && path.split("/").length >= 3 &&
      extension.test(leaf(path))),
  code: (path, hasLine) =>
    rooted.test(path) ||
    (path.includes("/")
      ? path.endsWith("/") || extension.test(leaf(path))
      : hasLine && extension.test(path)),
};

function recognize(raw: string, where: Where): PathMention | undefined {
  if (raw.length > MAX_CANDIDATE) return;
  const mention = splitPosition(raw);
  if (!mention) return;
  const { path } = mention;
  if (
    !characters.test(path) || !/\p{L}/u.test(path) || path.includes("//") ||
    path.split("/").includes("...")
  ) return;
  if (path.startsWith("~") && !path.startsWith("~/")) return;
  if (forms[where](path, !!mention.line)) return mention;
}

const cache = new Map<string, readonly PathSegment[]>();
export function pathSegments(
  text: string,
  where: TextContext,
  style: PathStyle = "posix",
): readonly PathSegment[] {
  const key = `${where}\0${style}\0${text}`;
  const saved = cache.get(key);
  if (saved) {
    cache.delete(key);
    cache.set(key, saved);
    return saved;
  }
  const segments: PathSegment[] = [];
  if (where === "code") {
    const raw = text.trim();
    const mention = sessionToken.test(raw)
      ? { raw, sessionID: raw }
      : style === "posix"
      ? recognize(raw, where)
      : undefined;
    segments.push(mention ? { text, mention } : { text });
  } else {
    let cursor = 0;
    const prompt = where === "prompt";
    for (
      const { 0: candidate, index, groups } of text.matchAll(
        prompt ? promptCandidates : candidates,
      )
    ) {
      // A backtick-delimited path can use whole-span recognition without
      // treating the delimiters, or any other prompt text, as Markdown.
      const quoted = groups?.quoted;
      const raw = quoted?.trim() ?? candidate.replace(/[.,]+$/, "");
      const start = quoted === undefined
        ? index
        : index + 1 + quoted.length - quoted.trimStart().length;
      const mention = groups?.session
        ? (prompt ? undefined : { raw, sessionID: raw })
        : style === "posix"
        ? recognize(raw, quoted === undefined ? "prose" : "code")
        : undefined;
      if (!mention) continue;
      if (cursor < start) segments.push({ text: text.slice(cursor, start) });
      segments.push({ text: raw, mention });
      cursor = start + raw.length;
    }
    if (cursor < text.length || !segments.length) {
      segments.push({ text: text.slice(cursor) });
    }
  }
  if (cache.size >= MAX_REMEMBERED) cache.delete(cache.keys().next().value!);
  cache.set(key, segments);
  return segments;
}

export function hrefPath(
  href: string,
  style: PathStyle = "posix",
): PathMention | undefined {
  if (
    style !== "posix" || !href || href.length > MAX_CANDIDATE ||
    /^[#?]/.test(href) || href.startsWith("//")
  ) return;
  const parsed = splitPosition(href);
  if (!parsed) return;
  let path = parsed.path;
  try {
    if (/^file:/i.test(path)) {
      if (
        !/^file:\/\/(?:localhost)?\/(?!\/)/i.test(path) ||
        /[\\\p{Cc}]/u.test(path)
      ) return;
      const url = new URL(path);
      if (url.hostname || url.hash || url.search) return;
      path = url.pathname;
    } else if (scheme.test(path) || /[?#]/.test(path)) return;
    path = decodeURIComponent(path);
  } catch {
    return;
  }
  if (
    !path || /^[~][^/]/.test(path) || path.startsWith("//") ||
    /[\\\p{Cc}]/u.test(path) || scheme.test(path)
  ) return;
  if (
    !rooted.test(path) && !path.includes("/") &&
    !leaf(path).slice(1).includes(".") && !/^\.[^.]/.test(path)
  ) return;
  return { ...parsed, path };
}

export function pathTooltip(fact: FileFactFound): string {
  if (fact.status === "directory") return `${fact.resolved} - Folder`;
  const ext = extension.exec(leaf(fact.resolved))?.[1];
  const type = fact.preview === "image"
    ? (ext ? `${ext.toUpperCase()} image` : "Image")
    : fact.preview === "text"
    ? "Text"
    : "File";
  return `${fact.resolved} - ${type}, ${formatBytes(fact.size)}`;
}

export function folderCommand(fact: FileFactFound): string {
  const folder = fact.status === "directory"
    ? fact.resolved
    : fact.resolved.slice(0, fact.resolved.lastIndexOf("/")) || "/";
  return `cd -- '${folder.replaceAll("'", "'\\''")}'`;
}
