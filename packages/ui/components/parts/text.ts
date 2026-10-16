// SPDX-License-Identifier: LGPL-3.0-only
import type { Block, Inline } from "@otk/protocol";
const inlineText = (items: Inline[]): string =>
  items.map((item): string => {
    if ("text" in item) return item.text;
    if ("inline" in item) return inlineText(item.inline);
    if (item.i === "image") return item.alt;
    return "\n";
  }).join("");
/** Source-owned plain text for message copying, independent of rendered DOM. */
export const blocksText = (blocks: Block[]): string =>
  blocks.map((block): string => {
    if ("inline" in block) return inlineText(block.inline);
    if (block.b === "code") return block.text;
    if (block.b === "quote") return blocksText(block.blocks);
    if (block.b === "list") {
      return block.items.map((item) => blocksText(item.blocks)).join("\n");
    }
    if (block.b === "table") {
      return [block.header, ...block.rows].map((row) =>
        row.map(inlineText).join("\t")
      ).join("\n");
    }
    return "";
  }).join("\n\n");
