// SPDX-License-Identifier: LGPL-3.0-only
import type { Block } from "@otk/protocol";
import { createSignal } from "solid-js";
import { DEFAULT_PREFS } from "@otk/protocol";
import Blocks from "../../components/Blocks.tsx";
import Reasoning from "../../components/Reasoning.tsx";
import { registerTextPart } from "../../components/parts/TextPart.tsx";
import { PartRegistry } from "../../registries/renderers.ts";
const blocks: Block[] = [
  {
    b: "heading",
    level: 2,
    inline: [{ i: "text", text: "A shared content boundary" }],
  },
  {
    b: "paragraph",
    inline: [
      { i: "strong", inline: [{ i: "text", text: "Deliberate prose" }] },
      { i: "text", text: " with " },
      { i: "code", text: "inline code" },
      { i: "text", text: "." },
    ],
  },
  {
    b: "quote",
    blocks: [{
      b: "paragraph",
      inline: [{ i: "text", text: "Nested content keeps the same rhythm." }],
    }],
  },
  {
    b: "list",
    ordered: false,
    items: [{
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: "One nested item" }],
      }],
    }],
  },
  { b: "code", text: "const value = 42;\nconsole.log(value);" },
];
const part = { id: "text", kind: "text" as const, blocks, synthetic: false };
const parts = new PartRegistry();
registerTextPart(parts);
const Text = parts.resolve(part)!;
export default function Scene() {
  const [conceal, setConceal] = createSignal(false);
  styleTest.conceal = setConceal;
  return (
    <div class="style-columns">
      <section class="style-panel" id="standalone">
        <h2>Standalone</h2>
        <Blocks blocks={blocks} {...{ conceal: conceal() }} />
      </section>
      <section class="style-panel" id="reasoning">
        <h2>Reasoning</h2>
        <Reasoning
          part={{
            id: "thinking",
            kind: "reasoning",
            blocks,
            time: { start: 0, end: 1200 },
          }}
          mode="show"
          {...{ conceal: conceal() }}
        />
      </section>
      <section class="style-panel" id="textpart">
        <h2>Text part</h2>
        <Text
          part={part}
          prefs={{ ...DEFAULT_PREFS, conceal: conceal() }}
          streaming={false}
          permissions={[]}
          paneWidth={1200}
          onOpenChild={() => {}}
          user={false}
        />
      </section>
    </div>
  );
}
