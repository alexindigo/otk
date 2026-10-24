// SPDX-License-Identifier: LGPL-3.0-only
import type { HighlightToken } from "./types.ts";
import { HIGHLIGHT_GROUP_ROWS } from "./policy.ts";
const ENDING = /\r\n|\n|\r/g;
/** One source coordinate system for layout, tokenizer jobs and publication. */
export function sourceLine(
  source: string,
  start: number,
  scanCarriageReturns = true,
) {
  if (!scanCarriageReturns) {
    const end = source.indexOf("\n", start);
    return end < 0
      ? { contentEnd: source.length, end: source.length, ending: "" }
      : { contentEnd: end, end: end + 1, ending: "\n" };
  }
  ENDING.lastIndex = start;
  const match = ENDING.exec(source);
  return match
    ? {
      contentEnd: match.index,
      end: match.index + match[0].length,
      ending: match[0],
    }
    : { contentEnd: source.length, end: source.length, ending: "" };
}
export const lineBreakCount = (text: string) =>
  !text.includes("\n") && !text.includes("\r")
    ? 0
    : text.match(/\r\n|\n|\r/g)?.length || 0;

/** The genuine source-group interval containing a native text position. */
export function sourceRange(source: string, offset: number) {
  offset = Math.max(0, Math.min(offset, source.length));
  if (source[offset] === "\n" && source[offset - 1] === "\r") offset--;
  const line = lineBreakCount(source.slice(0, offset));
  const beginning = (before: number) => {
    if (before <= 0) return 0;
    let start = Math.max(
      source.lastIndexOf("\n", before - 1),
      source.lastIndexOf("\r", before - 1),
    ) + 1;
    if (source[start - 1] === "\r" && source[start] === "\n") start++;
    return start;
  };
  let start = beginning(offset);
  for (let i = 0; i < line % HIGHLIGHT_GROUP_ROWS; i++) {
    const ending = source[start - 1] === "\n" && source[start - 2] === "\r"
      ? 2
      : 1;
    start = beginning(start - ending);
  }
  let end = start;
  const hasCarriageReturns = source.includes("\r");
  for (let i = 0; i < HIGHLIGHT_GROUP_ROWS && end < source.length; i++) {
    end = sourceLine(source, end, hasCarriageReturns).end;
  }
  return { start, end };
}

export interface SourceRow {
  readonly text: string;
  readonly fragments: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly newline: boolean;
  readonly ending: string;
}
export interface SourceGroup {
  readonly key: number;
  readonly rows: readonly SourceRow[];
  readonly start: number;
  readonly end: number;
}
interface PositionedToken {
  token: HighlightToken;
  start: number;
  end: number;
}

/** Source layout and token progress have independent lifetimes. */
let nextModel = 0, nextGroup = 0;
export class CodeProjection {
  readonly id = ++nextModel;
  readonly groups: SourceGroup[] = [];
  readonly dirty = new Set<number>();
  #reserved = new Map<number, SourceGroup>();
  #tokens: PositionedToken[] = [];
  #offset = 0;
  #group = 0;
  #complete = false;
  #source: string;
  #hasCarriageReturns: boolean;
  constructor(
    source: string,
    readonly lang: string,
    previous?: CodeProjection,
  ) {
    this.#source = source;
    this.#hasCarriageReturns = source.includes("\r");
    if (previous && source.startsWith(previous.source)) {
      this.#reserved = new Map(previous.#reserved);
      this.groups.push(...previous.groups);
      this.#offset = previous.#offset;
      this.#group = previous.#group;
      this.#complete = previous.#complete && source === previous.source;
      if (previous.#complete && !this.#complete) {
        this.#group = Math.max(0, this.groups.length - 1);
        this.#offset = this.groups[this.#group]?.start ?? 0;
      }
      for (let i = 0; i < this.groups.length; i++) this.dirty.add(i);
    }
  }
  get source() {
    return this.#source;
  }

  get complete() {
    return this.#complete;
  }
  get end() {
    return this.groups.at(-1)?.end ?? 0;
  }
  append(source: string): boolean {
    if (!source.startsWith(this.source)) return false;
    if (source === this.source) return true;
    this.#hasCarriageReturns ||= source.slice(this.#source.length).includes(
      "\r",
    );
    this.#source = source;
    if (this.#complete) {
      this.#group = Math.max(0, this.groups.length - 1);
      this.#offset = this.groups[this.#group]?.start ?? 0;
      this.#complete = false;
    }
    return true;
  }
  /** One raw-layout operation creates no more than one source group. */
  build(): { index: number; group: SourceGroup } | undefined {
    if (this.#complete) return;
    const index = this.#group, old = this.groups[index];
    const group = this.#read(
      this.#offset,
      old ?? this.#reserved.get(this.#offset),
    );
    this.#offset = group.end;
    this.#complete = !group.rows.at(-1)!.newline;
    this.groups[index] = group;
    this.#reserved.delete(group.start);
    this.#group++;
    this.dirty.add(index);
    return { index, group };
  }
  /** Actual viewport demand may own a bounded interval before its cold prefix. */
  reserve(start: number): SourceGroup {
    const range = sourceRange(this.source, start);
    if (range.start !== start) throw new Error("Source group is not aligned");
    const index = this.groups.findIndex((group) => group.start === start);
    const existing = this.groups[index];
    const group = this.#read(start, existing ?? this.#reserved.get(start));
    if (!existing) this.#reserved.set(start, group);
    else if (existing !== group) {
      this.groups[index] = group;
      this.dirty.add(index);
    }
    return group;
  }
  #read(start: number, old?: SourceGroup): SourceGroup {
    const rows: SourceRow[] = [];
    let position = start;
    for (let i = 0; i < HIGHLIGHT_GROUP_ROWS; i++) {
      const offset = position;
      const line = sourceLine(this.source, offset, this.#hasCarriageReturns);
      const end = line.end;
      const text = this.source.slice(offset, line.contentEnd);
      const previous = old?.rows[i];
      rows.push(
        previous && previous.text === text &&
          previous.ending === line.ending && previous.start === offset
          ? previous
          : Object.freeze({
            text,
            start: offset,
            end,
            newline: !!line.ending,
            ending: line.ending,
            // Append nodes, never replace selected CharacterData. Completed
            // prefixes share immutable fragments across source revisions.
            fragments: Object.freeze(
              previous && text.startsWith(previous.text)
                ? text.length === previous.text.length
                  ? previous.fragments
                  : [...previous.fragments, text.slice(previous.text.length)]
                : text
                ? [text]
                : [],
            ),
          }),
      );
      position = end;
      if (!line.ending) break;
    }
    const group = old && rows.length === old.rows.length &&
        rows.every((row, i) => row === old.rows[i])
      ? old
      : Object.freeze({
        key: old?.key ?? ++nextGroup,
        rows: Object.freeze(rows),
        start,
        end: position,
      });
    return group;
  }

  /** Reject a stale generation before accepting its suffix/recall. */
  *accept(lang: string, text: string, from: number, tokens: HighlightToken[]) {
    if (lang !== this.lang || !this.source.startsWith(text)) return;
    if (from < 0 || from > this.#tokens.length) {
      throw new Error("Invalid recall");
    }
    let offset = this.#tokens[from]?.start ?? this.#tokens.at(-1)?.end ?? 0;
    const replaced = this.#tokens.at(-1)?.end ?? offset;
    this.#tokens.length = from;
    this.#mark(offset, replaced);
    let lines = 0, start = offset;
    for (const token of tokens) {
      const end = offset + token.content.length;
      this.#tokens.push({ token, start: offset, end });
      offset = end;
      lines += lineBreakCount(token.content);
      if (lines >= HIGHLIGHT_GROUP_ROWS) {
        this.#mark(start, offset);
        yield;
        start = offset;
        lines = 0;
      }
    }
    this.#mark(start, offset);
  }
  #mark(start: number, end: number) {
    for (let i = this.#findGroup(start); i < this.groups.length; i++) {
      if (this.groups[i].start > end) break;
      this.dirty.add(i);
    }
  }
  #findGroup(offset: number) {
    let low = 0, high = this.groups.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.groups[mid].end <= offset) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  /** A viewport request projects only its own bounded source group. */
  project(group: SourceGroup): HighlightToken[][] | undefined {
    if ((this.#tokens.at(-1)?.end ?? 0) < group.end) return;
    return this.#project(group, this.#tokens);
  }
  projectSource(
    group: SourceGroup,
    start: number,
    tokens: HighlightToken[],
  ): HighlightToken[][] | undefined {
    if (start !== group.start) return;
    const positions: PositionedToken[] = [];
    let offset = start;
    for (const token of tokens) {
      const end = offset + token.content.length;
      positions.push({ token, start: offset, end });
      offset = end;
    }
    if (offset < group.end) return;
    return this.#project(group, positions);
  }
  #project(
    group: SourceGroup,
    positions: PositionedToken[],
  ): HighlightToken[][] {
    let low = 0, high = positions.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (positions[mid].end <= group.start) low = mid + 1;
      else high = mid;
    }
    let cursor = low;
    const projection = group.rows.map((row) => {
      const result: HighlightToken[] = [];
      while (
        cursor < positions.length && positions[cursor].end <= row.start
      ) {
        cursor++;
      }
      for (let i = cursor; i < positions.length; i++) {
        const item = positions[i];
        const end = row.end - row.ending.length;
        if (item.start >= end) break;
        const start = Math.max(row.start, item.start);
        const stop = Math.min(end, item.end);
        if (stop > start) {
          result.push({
            ...item.token,
            content: item.token.content.slice(
              start - item.start,
              stop - item.start,
            ),
          });
        }
      }
      return result;
    });
    // A selected projection is a value snapshot, never a mutable store proxy.
    for (const row of projection) {
      for (const token of row) Object.freeze(token);
      Object.freeze(row);
    }
    Object.freeze(projection);
    return projection;
  }
}
