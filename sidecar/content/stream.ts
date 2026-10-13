// SPDX-License-Identifier: LGPL-3.0-only
import type { Links, Tokens } from "marked";
import type { Block } from "@otk/protocol";
import { blocks, lex } from "./markdown.ts";
/** An unfinished part owns its raw source. Stable prefixes are never re-lexed. */
export class StreamingMarkdown {
  text = "";
  #offset = 0;
  #stable = 0;
  #links: Links = {};
  constructor(text = "") {
    this.text = text;
  }
  append(delta: string): void {
    this.text += delta;
  }
  replace(text: string): void {
    if (text.startsWith(this.text)) {
      this.text = text;
      return;
    }
    this.text = text;
    this.#offset = this.#stable = 0;
    this.#links = {};
  }
  flush(): { from: number; blocks: Block[] } {
    // Marked normalizes CRLF/CR before lexing, so offsets live in that same
    // normalized coordinate space (including a CRLF split across deltas).
    const tail = this.text.replace(/\r\n|\r/g, "\n").slice(this.#offset);
    const { tokens } = lex(tail, this.#links);
    const result = { from: this.#stable, blocks: blocks(tokens) };
    // A whitespace token cannot stabilize the preceding paragraph/list: further
    // input can extend it. Keep the final meaningful top-level token unstable.
    let end = tokens.findLastIndex((t) =>
      t.type !== "space" && t.type !== "def"
    );
    // Reference definitions may arrive after use. Keep any reference-bearing
    // token in the unstable suffix so later definitions can resolve it correctly.
    const reference = tokens.findIndex((t) =>
      /(?<!\\)\[[^\]\n]+\](?!\()/.test(t.raw) && t.type !== "code"
    );
    if (reference >= 0) end = Math.min(end, reference);
    const stable = tokens.slice(0, Math.max(0, end));
    this.#stable += blocks(stable).length;
    this.#offset += stable.reduce((n, t) => n + t.raw.length, 0);
    for (const token of stable) {
      if (token.type === "def") {
        const definition = token as Tokens.Def;
        this.#links[definition.tag] ??= {
          href: definition.href,
          title: definition.title,
        };
      }
    }
    return result;
  }
}
