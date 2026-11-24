// SPDX-License-Identifier: LGPL-3.0-only
import "./WorkLog.css" with { type: "text" };
import type { Element } from "solid-js";
import { retainedWorkDisclosure } from "../features/transcript-context.tsx";
import ChromeMeta, { MetaRow } from "./ChromeMeta.tsx";
import { TreeIcon, TreeNode } from "./Tree.tsx";
import type { Preferences } from "@otk/protocol";

export default function WorkLog(
  props: {
    owner: string;
    records: readonly string[];
    prefs?: Preferences;
    required?: boolean;
    meta?(primary: () => Element): Element;
    body(): Element;
  },
): Element {
  const [open, setOpen] = retainedWorkDisclosure(
    props.owner,
    () => props.records,
    () => props.prefs ?? {},
    () => !!props.required,
  );
  const primary = (toggleID: string) => (
    <button
      id={toggleID}
      type="button"
      title="Work log"
      class="otk-work-fold otk-tree-control"
      aria-expanded={open() ? "true" : "false"}
      onClick={() => setOpen(!open())}
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
