// SPDX-License-Identifier: LGPL-3.0-only
import "./Reasoning.css" with { type: "text" };
import { createSignal, Show } from "solid-js";
import type { Part } from "@otk/protocol";
import Blocks from "./Blocks.tsx";
import { ownedAction } from "../keyboard/context.tsx";
export default function Reasoning(
  props: { part: Extract<Part, { kind: "reasoning" }>; mode: "show" | "hide" },
) {
  const [expanded, setExpanded] = createSignal(false);
  const toggle = ownedAction(
    "reasoning.toggle",
    () => setExpanded((value) => !value),
  );
  const open = () => props.mode === "show" || expanded();
  const heading = () => {
    const first = props.part.blocks[0];
    return first?.b === "paragraph" && first.inline.length === 1 &&
        first.inline[0].i === "strong"
      ? first.inline[0].inline.filter((item) => item.i === "text").map((item) =>
        item.text
      ).join("")
      : undefined;
  };
  const title = () => props.part.title || heading();
  return (
    <section class="otk-reasoning">
      <button
        type="button"
        aria-expanded={open() ? "true" : "false"}
        disabled={props.mode === "show"}
        onClick={() => void toggle()}
      >
        <Show when={props.part.time.end === undefined}>
          <span class="otk-dot otk-busy" />
        </Show>
        {props.part.time.end === undefined ? "Thinking" : "Thought"}
        {title() ? `: ${title()}` : ""}
        {props.part.time.end !== undefined
          ? ` · ${
            Math.max(0, (props.part.time.end - props.part.time.start) / 1000)
              .toFixed(1)
          }s`
          : ""}
      </button>
      <Show when={open()}>
        <div class="otk-reasoning-body">
          <Blocks
            blocks={heading() ? props.part.blocks.slice(1) : props.part.blocks}
          />
        </div>
      </Show>
    </section>
  );
}
