// SPDX-License-Identifier: LGPL-3.0-only
import "./WorkLog.css" with { type: "text" };
import type { Element } from "solid-js";
import { retainedDisclosure } from "../features/transcript-context.tsx";
import { ownedAction } from "../keyboard/context.tsx";
import ChromeMeta, { MetaRow } from "./ChromeMeta.tsx";
import { TreeIcon, TreeNode } from "./Tree.tsx";
import type { Preferences } from "@otk/protocol";

export default function WorkLog(
  props: {
    identity?: string;
    prefs?: Preferences;
    required?: boolean;
    meta?(primary: () => Element): Element;
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
  const primary = (toggleID: string) => (
    <button
      id={toggleID}
      type="button"
      title="Work log"
      class="otk-work-fold otk-tree-control"
      aria-expanded={open() ? "true" : "false"}
      onClick={() => void toggle()}
    >
      <TreeIcon />
      <ChromeMeta class="otk-work-label">Work log</ChromeMeta>
    </button>
  );
  return (
    <section class="otk-work-log">
      <TreeNode
        toggleHeader
        label="Work log"
        open={open()}
        onOpen={(value) => setOpen(value)}
        header={(_connected, toggleID) =>
          props.meta
            ? props.meta(() => primary(toggleID))
            : <MetaRow>{primary(toggleID)}</MetaRow>}
        body={() => <div class="otk-work-body">{props.body()}</div>}
      />
    </section>
  );
}
