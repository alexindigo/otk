// SPDX-License-Identifier: LGPL-3.0-only
import "./Diff.css" with { type: "text" };
import { For, Show } from "solid-js";
import type { FileDiff, Hunk } from "@otk/protocol";
import Diagnostics from "./tools/Diagnostics.tsx";
type Line = Hunk["lines"][number];
export function splitRows(lines: Line[]): { left?: Line; right?: Line }[] {
  const rows: { left?: Line; right?: Line }[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === "context") {
      rows.push({ left: lines[i], right: lines[i] });
      i++;
      continue;
    }
    const deleted: Line[] = [], added: Line[] = [];
    while (i < lines.length && lines[i].kind !== "context") {
      (lines[i].kind === "del" ? deleted : added).push(lines[i++]);
    }
    for (let n = 0; n < Math.max(deleted.length, added.length); n++) {
      rows.push({ left: deleted[n], right: added[n] });
    }
  }
  return rows;
}
function Cell(props: { line?: Line; side: "old" | "new" }) {
  return (
    <div
      class="otk-diff-cell"
      data-line-kind={props.line?.kind || "empty"}
      data-old-line={props.line?.oldNo}
      data-new-line={props.line?.newNo}
    >
      <span class="otk-diff-number">
        {props.side === "old" ? props.line?.oldNo : props.line?.newNo}
      </span>
      <span class="otk-diff-sign">
        {props.line?.kind === "add"
          ? "+"
          : props.line?.kind === "del"
          ? "−"
          : " "}
      </span>
      <span class="otk-diff-text">{props.line?.text}</span>
    </div>
  );
}
export default function Diff(
  props: {
    file: FileDiff;
    style: "auto" | "split" | "unified";
    wrap: boolean;
    paneWidth: number;
  },
): import("solid-js").Element {
  const style = () =>
    props.style === "auto"
      ? (props.paneWidth >= 1200 ? "split" : "unified")
      : props.style;
  const label = () =>
    ({
      added: "Created",
      deleted: "Deleted",
      moved: "Moved",
      modified: "Modified",
    })[props.file.status];
  return (
    <section
      class={["otk-diff", { "otk-diff-wrap": props.wrap }]}
      data-diff-style={style()}
      data-file-status={props.file.status}
    >
      <header>
        <strong>{label()}</strong>
        <span>
          {props.file.oldPath ? `${props.file.oldPath} → ` : ""}
          {props.file.path}
        </span>
        <span class="otk-diff-add">+{props.file.additions}</span>
        <span class="otk-diff-del">−{props.file.deletions}</span>
      </header>
      <For each={props.file.hunks} keyed={false}>
        {(hunk) => (
          <div class="otk-diff-content">
            <div class="otk-hunk-header">
              @@ −{hunk().oldStart},{hunk().oldLines}{" "}
              +{hunk().newStart},{hunk().newLines} @@
            </div>
            <Show
              when={style() === "split"}
              fallback={
                <For each={hunk().lines} keyed={false}>
                  {(line) => (
                    <div
                      class="otk-diff-unified"
                      data-line-kind={line().kind}
                      data-old-line={line().oldNo}
                      data-new-line={line().newNo}
                    >
                      <span class="otk-diff-number">{line().oldNo}</span>
                      <span class="otk-diff-number">{line().newNo}</span>
                      <span class="otk-diff-sign">
                        {line().kind === "add"
                          ? "+"
                          : line().kind === "del"
                          ? "−"
                          : " "}
                      </span>
                      <span class="otk-diff-text">{line().text}</span>
                    </div>
                  )}
                </For>
              }
            >
              <For each={splitRows(hunk().lines)} keyed={false}>
                {(row) => (
                  <div class="otk-diff-split-row">
                    <Cell line={row().left} side="old" />
                    <Cell line={row().right} side="new" />
                  </div>
                )}
              </For>
            </Show>
          </div>
        )}
      </For>
      <Diagnostics items={props.file.diagnostics || []} />
    </section>
  );
}
