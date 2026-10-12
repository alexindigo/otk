// SPDX-License-Identifier: LGPL-3.0-only
import {
  createMemo,
  createSignal,
  type Element,
  For,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import type { SourceRow } from "../highlight/lines.ts";
import type { HighlightToken } from "../highlight/types.ts";
const OVERSCAN = "100% 0px";

function Row(props: { row: SourceRow; children: Element; key?: number }) {
  return (
    <span class="otk-code-line">
      {props.children}
      <span class="otk-code-newline">{props.row.ending}</span>
    </span>
  );
}
function Fragments(props: { row: SourceRow; from?: number }) {
  const parts = createMemo(() => {
    let offset = props.from || 0;
    if (!offset) return props.row.fragments;
    const result: string[] = [];
    for (const fragment of props.row.fragments) {
      if (offset >= fragment.length) offset -= fragment.length;
      else {
        result.push(fragment.slice(offset));
        offset = 0;
      }
    }
    return result;
  });
  return (
    <For each={parts()} keyed={false}>{(fragment) => <>{fragment()}</>}</For>
  );
}
function Raw(props: { rows: readonly SourceRow[] }) {
  const initial = untrack(() => props.rows);
  if (
    initial.length === 32 &&
    initial.every((row) => row.newline && row.ending !== "\r")
  ) {
    // Complete immutable source uses native preformatted lines. Row/token
    // elements belong to warm projections; unfinished groups keep the append
    // graph below so selected source endpoints are never replaced.
    return (
      <span class="otk-code-raw">
        {initial.map((row) => row.text + row.ending).join("")}
      </span>
    );
  }
  return (
    <For each={props.rows} keyed={(row) => row.start}>
      {(row) => {
        // Complete source rows are immutable across compatible appends. They
        // need one text node, not a memo/list graph for future fragments. Only
        // the unfinished tail owns that append machinery and its endpoint nodes.
        const initial = untrack(row);
        return initial.newline && initial.ending !== "\r"
          ? <Row row={initial}>{initial.text}</Row>
          : (
            <Row row={row()}>
              <Fragments row={row()} />
            </Row>
          );
      }}
    </For>
  );
}
function Styled(
  props: { rows: readonly SourceRow[]; tokens: HighlightToken[][] },
) {
  return (
    <For each={props.rows} keyed={(row) => row.start}>
      {(row, index) => (
        <Row row={row()}>
          <For each={props.tokens[index()] || []} keyed={false}>
            {(token) => (
              <span
                class={["otk-token", {
                  "otk-token-bold": !!((token().fontStyle || 0) & 2),
                  "otk-token-italic": !!((token().fontStyle || 0) & 1),
                  "otk-token-underline": !!((token().fontStyle || 0) & 4),
                }]}
                style={{ color: token().color }}
              >
                {token().content}
              </span>
            )}
          </For>
          <Fragments
            row={row()}
            from={(props.tokens[index()] || []).reduce(
              (n, token) => n + token.content.length,
              0,
            )}
          />
        </Row>
      )}
    </For>
  );
}
export default function CodeGroup(props: {
  rows: readonly SourceRow[];
  tokens?: HighlightToken[][];
  onDemand(visible: boolean): void;
}) {
  const [visible, setVisible] = createSignal(false);
  const [selectionVersion, setSelectionVersion] = createSignal(0);
  let element!: HTMLSpanElement, held: HighlightToken[][] | undefined;
  const projection = createMemo(() => {
    const tokens = props.tokens, warm = visible();
    selectionVersion();
    const selection = document.getSelection();
    if (
      element && selection &&
      (element.contains(selection.anchorNode) ||
        element.contains(selection.focusNode))
    ) return held;
    held = warm ? tokens : undefined;
    return held;
  });
  onSettled(() => {
    const observer = new IntersectionObserver((entries) => {
      const warm = entries.some((entry) =>
        entry.target === element && entry.isIntersecting
      );
      setVisible(warm);
      props.onDemand(warm);
    }, { rootMargin: OVERSCAN, scrollMargin: OVERSCAN });
    const select = () => setSelectionVersion((value) => value + 1);
    observer.observe(element);
    document.addEventListener("selectionchange", select);
    return () => {
      observer.disconnect();
      document.removeEventListener("selectionchange", select);
      props.onDemand(false);
    };
  });
  return (
    <span
      class="otk-code-group"
      ref={(el) => {
        element = el;
      }}
    >
      <Show when={projection()} fallback={<Raw rows={props.rows} />}>
        {(tokens) => <Styled rows={props.rows} tokens={tokens()} />}
      </Show>
    </span>
  );
}
