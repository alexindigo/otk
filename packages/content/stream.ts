// SPDX-License-Identifier: LGPL-3.0-only
import type { Links, Tokens } from "marked";
import type { Block } from "@otk/protocol";
import { blocks, lex } from "./markdown.ts";
/** An unfinished part owns its raw source. Stable prefixes are never re-lexed. */
export class StreamingMarkdown {
  #text = "";
  get text(): string {
    return this.#text;
  }
  #offset = 0;
  #stable: Block[] = [];
  #published = 0;
  #links: Links = {};
  #normalized = "";
  #cr = false;
  #revision = 0;
  #parsed?: { revision: number; blocks: Block[] };
  constructor(text: string = "") {
    this.append(text);
  }
  append(delta: string): void {
    if (!delta) return;
    this.#text += delta;
    // Normalize only the new raw source, carrying CR across native chunks.
    this.#normalized +=
      (this.#cr && delta.startsWith("\n") ? delta.slice(1) : delta).replace(
        /\r\n|\r/g,
        "\n",
      );
    this.#cr = delta.endsWith("\r");
    this.#revision++;
    this.#parsed = undefined;
  }
  replace(text: string): void {
    if (text.startsWith(this.text)) {
      this.append(text.slice(this.text.length));
      return;
    }
    this.#text = "";
    this.#normalized = "";
    this.#cr = false;
    this.#offset = this.#published = 0;
    this.#stable = [];
    this.#links = {};
    this.#parsed = undefined;
    this.#revision++;
    this.append(text);
  }
  flush(): { from: number; blocks: Block[] } {
    const parsed = this.snapshot();
    const result = {
      from: this.#published,
      blocks: parsed.blocks.slice(this.#published),
    };
    this.#published = this.#stable.length;
    return result;
  }
  snapshot(): { revision: number; blocks: Block[] } {
    if (this.#parsed) return this.#parsed;
    const tail = this.#normalized.slice(this.#offset);
    const { tokens } = lex(tail, this.#links);
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
    const boundary = Math.max(0, end);
    // Each token is converted once; stable objects belong to this producer.
    const converted = tokens.map((token) => blocks([token]));
    const result = {
      revision: this.#revision,
      blocks: [...this.#stable, ...converted.flat()],
    };
    const stable = tokens.slice(0, boundary);
    for (let i = 0; i < boundary; i++) {
      for (const block of converted[i]) this.#stable.push(block);
    }
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
    return this.#parsed = result;
  }
  finish(): { revision: number; blocks: Block[] } {
    return this.snapshot();
  }
}
