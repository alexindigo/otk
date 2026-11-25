// SPDX-License-Identifier: LGPL-3.0-only
import "./WorkLog.css" with { type: "text" };
import type { Element } from "solid-js";
import { retainedDisclosure } from "../features/transcript-context.tsx";
import { ownedAction } from "../keyboard/context.tsx";
import { workingTime } from "./work-log.ts";
import { TreeIcon, TreeNode } from "./Tree.tsx";
import type { Preferences } from "@otk/protocol";

export default function WorkLog(
  props: {
    workingMs?: number;
    identity?: string;
    prefs?: Preferences;
    required?: boolean;
    body(): Element;
  },
): Element {
  const [open, setOpen] = retainedDisclosure(
    "work:" + props.identity,
    "work",
    () => props.prefs ?? {},
    undefined,
    () => !!props.required,
  );
  const toggle = ownedAction("work.toggle", () => setOpen(!open()));
  const label = () => workingTime(props.workingMs) ?? "Work log";
  return (
    <section class="otk-work-log">
      <TreeNode
        toggleHeader
        label={label()}
        open={open()}
        onOpen={(value) => setOpen(value)}
        header={(_connected, toggleID) => (
          <button
            id={toggleID}
            type="button"
            class="otk-work-fold otk-tree-control"
            aria-expanded={open() ? "true" : "false"}
            onClick={() => void toggle()}
          >
            <TreeIcon />
            <span class="otk-work-label">{label()}</span>
          </button>
        )}
        body={() => <div class="otk-work-body">{props.body()}</div>}
      />
    </section>
  );
}
