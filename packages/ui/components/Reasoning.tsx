// SPDX-License-Identifier: LGPL-3.0-only
import "./Reasoning.css" with { type: "text" };
import { Show } from "solid-js";
import { retainedDisclosure } from "../features/transcript-context.tsx";
import type { Part } from "@otk/protocol";
import { duration } from "@otk/client";
import Blocks from "./Blocks.tsx";
import ActivityIndicator from "./ActivityIndicator.tsx";
import { ownedAction } from "../keyboard/context.tsx";
import { ChevronIcon } from "./ChromeIcons.tsx";
export default function Reasoning(
  props: {
    part: Extract<Part, { kind: "reasoning" }>;
    mode: "show" | "hide";
    conceal?: boolean;
  },
) {
  const [open, setExpanded] = retainedDisclosure(
    "reasoning",
    "reasoning",
    () => ({ thinking: props.mode }),
  );
  const toggle = ownedAction(
    "reasoning.toggle",
    () => setExpanded(!open()),
  );
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
  function Heading() {
    return (
      <>
        <Show when={props.part.time.end === undefined}>
          <ActivityIndicator small />
        </Show>
        {props.part.time.end === undefined ? "Thinking…" : "Thought for"}
        {props.part.time.end !== undefined
          ? ` ${duration(props.part.time.end - props.part.time.start)}`
          : ""}
      </>
    );
  }
  return (
    <section class={["otk-reasoning", { "is-open": open() }]}>
      <button
        type="button"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => void toggle()}
      >
        <ChevronIcon class="otk-reasoning-chevron" />
        <Heading />
      </button>
      <Show when={open()}>
        <div class="otk-reasoning-body">
          <Show when={title()}>
            <strong>{title()}</strong>
          </Show>
          <Blocks
            blocks={heading() ? props.part.blocks.slice(1) : props.part.blocks}
            conceal={props.conceal}
          />
        </div>
      </Show>
    </section>
  );
}
