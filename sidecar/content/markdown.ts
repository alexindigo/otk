// SPDX-License-Identifier: LGPL-3.0-only
import { Lexer, type Links, type Token, Tokenizer, type Tokens } from "marked";
import type { Block, Inline } from "../../protocol/content.ts";
class MarkdownTokenizer extends Tokenizer {
  override lheading(src: string): Tokens.Heading | undefined {
    // Marked's GFM setext regex backtracks over every character before failing,
    // retaining a large native regex stack for long paragraphs. An underline
    // line is required by that grammar; skip only this impossible candidate.
    if (!/\n {0,3}(?:=+|-+) *(?:\n|$)/.test(src)) return;
    return super.lheading(src);
  }
}
export function inline(tokens: Token[]): Inline[] {
  return tokens.map((token): Inline => {
    switch (token.type) {
      case "strong":
      case "em":
      case "del":
        return {
          i: token.type,
          inline: inline((token as Tokens.Strong).tokens),
        };
      case "codespan":
        return { i: "code", text: (token as Tokens.Codespan).text };
      case "link": {
        const t = token as Tokens.Link;
        return { i: "link", href: t.href, inline: inline(t.tokens) };
      }
      case "image": {
        const t = token as Tokens.Image;
        return { i: "image", src: t.href, alt: t.text };
      }
      case "br":
        return { i: "break" };
      default:
        return {
          i: "text",
          text: String("text" in token ? token.text : token.raw),
        };
    }
  });
}
export function blocks(tokens: Token[]): Block[] {
  return tokens.flatMap((token): Block[] => {
    switch (token.type) {
      case "space":
      case "def":
        return [];
      case "heading": {
        const t = token as Tokens.Heading;
        return [{
          b: "heading",
          level: t.depth as 1 | 2 | 3 | 4 | 5 | 6,
          inline: inline(t.tokens),
        }];
      }
      case "code": {
        const t = token as Tokens.Code;
        return [{
          b: "code",
          lang: t.lang?.split(/\s+/)[0] || undefined,
          text: t.text,
        }];
      }
      case "list": {
        const t = token as Tokens.List;
        return [{
          b: "list",
          ordered: t.ordered,
          start: typeof t.start === "number" ? t.start : undefined,
          items: t.items.map((item) => ({
            task: item.task,
            checked: item.checked,
            blocks: blocks(item.tokens),
          })),
        }];
      }
      case "blockquote":
        return [{
          b: "quote",
          blocks: blocks((token as Tokens.Blockquote).tokens),
        }];
      case "table": {
        const t = token as Tokens.Table;
        return [{
          b: "table",
          align: t.align,
          header: t.header.map((cell) => inline(cell.tokens)),
          rows: t.rows.map((row) => row.map((cell) => inline(cell.tokens))),
        }];
      }
      case "hr":
        return [{ b: "rule" }];
      case "html":
        return [{ b: "paragraph", inline: [{ i: "text", text: token.raw }] }];
      default:
        return [{
          b: "paragraph",
          inline: "tokens" in token && token.tokens ? inline(token.tokens) : [{
            i: "text",
            text: String("text" in token ? token.text : token.raw),
          }],
        }];
    }
  });
}
export function lex(
  text: string,
  links: Links = {},
): { tokens: Token[]; links: Links } {
  const lexer = new Lexer({ gfm: true, tokenizer: new MarkdownTokenizer() });
  lexer.tokens.links = { ...links };
  return { tokens: lexer.lex(text), links: lexer.tokens.links };
}
export const markdown = (text: string): Block[] => blocks(lex(text).tokens);
