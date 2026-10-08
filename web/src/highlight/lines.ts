// SPDX-License-Identifier: LGPL-3.0-only
import type { HighlightToken } from "./types.ts";
export interface CodeLine {
  tokens: HighlightToken[];
  newline: boolean;
  end: number;
}
/** Immutable line identities keep a streamed suffix out of the stable DOM. */
export function codeLines(
  tokens: HighlightToken[],
  previous: CodeLine[] = [],
): CodeLine[] {
  const lines: CodeLine[] = [];
  let row: HighlightToken[] = [], end = 0;
  const finish = (newline: boolean) => {
    const old = previous[lines.length];
    if (
      old && old.newline === newline && old.end === end &&
      old.tokens.length === row.length &&
      row.every((token, i) =>
        token.content === old.tokens[i].content &&
        token.color === old.tokens[i].color &&
        token.fontStyle === old.tokens[i].fontStyle
      )
    ) {
      lines.push(old);
    } else {
      Object.freeze(row);
      lines.push(Object.freeze({ tokens: row, newline, end }));
    }
    row = [];
  };
  for (const token of tokens) {
    if (!token.content.includes("\n")) {
      row.push(token);
      end += token.content.length;
      continue;
    }
    const pieces = token.content.split("\n");
    for (const [i, content] of pieces.entries()) {
      if (content) {
        row.push({ ...token, content });
        end += content.length;
      }
      if (i < pieces.length - 1) {
        end++;
        finish(true);
      }
    }
  }
  if (row.length) finish(false);
  return lines;
}
