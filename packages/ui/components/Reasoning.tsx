// SPDX-License-Identifier: LGPL-3.0-only
import "./Reasoning.css" with { type: "text" };
import { Show } from "solid-js";
import { transcriptDisclosureIdentity } from "../features/transcript-context.tsx";
import type { Part } from "@otk/protocol";
import { elapsed } from "@otk/client";
import TimeText from "./TimeText.tsx";
import Blocks from "./Blocks.tsx";
import ActivityIndicator from "./ActivityIndicator.tsx";
import { TreeItem, TreeNode } from "./Tree.tsx";
import { ActivityIcon } from "./ChromeIcons.tsx";
import Disclosure from "./Disclosure.tsx";
export default function Reasoning(
  props: {
    part: Extract<Part, { kind: "reasoning" }>;
    mode: "show" | "hide";
    conceal?: boolean;
  },
) {
  const identify = transcriptDisclosureIdentity();
  const hasContent = () => !!(props.part.title || props.part.blocks.length);
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
        {props.part.time.end === undefined ? "Thinking..." : "Thought for"}
        <Show when={props.part.time.end !== undefined}>
          {" "}
          <TimeText
            time={elapsed(props.part.time.end! - props.part.time.start)}
          />
        </Show>
      </>
    );
  }
  return (
    <Disclosure
      kind="reasoning"
      identity={identify()}
      input={{ category: "reasoning", prefs: () => ({ thinking: props.mode }) }}
      variant="label"
      class="otk-reasoning-heading"
      label="Thought"
      labelContent={() => <Heading />}
      hasContent={hasContent}
      lead={() => (
        <Show
          when={props.part.time.end === undefined}
          fallback={<ActivityIcon />}
        >
          <ActivityIndicator small decorative />
        </Show>
      )}
      layout={({ trigger, region, open, frame }) => (
        <section class={["otk-reasoning", { "is-open": open() }]}>
          <TreeNode
            class="otk-reasoning-row"
            ref={frame}
            trigger={{ variant: "span", element: trigger, hasBox: hasContent }}
            bodyVisible={open()}
            region={region}
          />
        </section>
      )}
    >
      {() => (
        <TreeItem last>
          <TreeNode
            header={() => (
              <div class="otk-reasoning-body">
                <Show when={title()}>
                  <strong>{title()}</strong>
                </Show>
                <Blocks
                  blocks={heading()
                    ? props.part.blocks.slice(1)
                    : props.part.blocks}
                  conceal={props.conceal}
                />
              </div>
            )}
          />
        </TreeItem>
      )}
    </Disclosure>
  );
}
