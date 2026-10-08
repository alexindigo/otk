// SPDX-License-Identifier: LGPL-3.0-only
import {
  createEffect,
  createSignal,
  createStore,
  For,
  onSettled,
  Show,
} from "solid-js";
import { highlightBlock } from "../highlight/client.ts";
import type { HighlightToken } from "../highlight/types.ts";
import { type CodeLine, codeLines } from "../highlight/lines.ts";
interface LineGroup {
  lines: CodeLine[];
  end: number;
}
const NEWLINE = "\n";
function TokenLine(props: { line: CodeLine; tail: string }) {
  return (
    <span class="otk-code-line">
      <For each={props.line.tokens} keyed={false}>
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
      {props.tail}
      <Show when={props.line.newline}>
        <span class="otk-code-newline">{NEWLINE}</span>
      </Show>
    </span>
  );
}
export default function Code(
  props: {
    text: string;
    lang?: string;
    streaming?: boolean;
    lineNumbers?: boolean;
  },
) {
  const block = highlightBlock();
  const [state, setState] = createStore({
    groups: [] as LineGroup[],
    text: "",
    lang: "",
    length: 0,
  });
  const [error, setError] = createSignal("");
  let disposed = false, busy = false, revision = 0, rendered = 0;
  let timer: ReturnType<typeof setTimeout> | undefined,
    paint: number | undefined;
  let target: HighlightToken[] = [], targetText = "", targetLang = "";
  let lines: CodeLine[] = [], groups: LineGroup[] = [];
  const publish = () => {
    paint = undefined;
    if (disposed) return;
    const end = Math.min(rendered + 32, lines.length);
    const next: LineGroup[] = [];
    for (let start = 0; start < end; start += 32) {
      const rows = lines.slice(start, Math.min(start + 32, end));
      const old = groups[next.length];
      if (
        old && old.lines.length === rows.length &&
        rows.every((row, i) => row === old.lines[i])
      ) next.push(old);
      else {
        Object.freeze(rows);
        next.push(Object.freeze({ lines: rows, end: rows.at(-1)!.end }));
      }
    }
    groups = next;
    rendered = end;
    setState((draft) => {
      draft.groups = next;
      draft.length = next.at(-1)?.end || 0;
      draft.text = targetText;
      draft.lang = targetLang;
    });
    if (end < lines.length) paint = requestAnimationFrame(publish);
  };
  const flush = async () => {
    timer = undefined;
    if (busy || disposed) return;
    busy = true;
    const generation = revision,
      source = props.text,
      lang = (props.lang || "text").toLowerCase();
    // Bound each job, including a snapshot or a large append, so the shared
    // worker can serve other code views before processing this whole block.
    let end = targetLang === lang && source.startsWith(targetText)
      ? targetText.length
      : 0;
    for (let line = 0; line < 32 && end < source.length; line++) {
      const newline = source.indexOf("\n", end);
      end = newline < 0 ? source.length : newline + 1;
    }
    const text = source.slice(0, end);
    let continuing = end < source.length;
    try {
      const result = await block.update(
        lang,
        text,
        continuing || (props.streaming ?? false),
      );
      if (disposed) return;
      if (
        props.text.startsWith(text) &&
        (props.lang || "text").toLowerCase() === lang
      ) {
        if (paint !== undefined) cancelAnimationFrame(paint);
        target.splice(
          result.from,
          target.length - result.from,
          ...result.tokens,
        );
        if (result.plain || result.error) continuing = false;
        targetText = result.plain || result.error ? source : text;
        targetLang = lang;
        lines = codeLines(target, lines);
        rendered = Math.min(rendered, lines.length);
        setError(result.error ? "Highlighting unavailable" : "");
        publish();
      }
    } catch (error) {
      continuing = false;
      if (!disposed) setError((error as Error).message);
    } finally {
      busy = false;
      if (!disposed && (revision !== generation || continuing)) {
        timer = setTimeout(() => void flush(), 50);
      }
    }
  };
  createEffect(
    () => ({ text: props.text, lang: props.lang, streaming: props.streaming }),
    () => {
      revision++;
      if (timer === undefined) timer = setTimeout(() => void flush(), 50);
    },
  );
  onSettled(() => () => {
    disposed = true;
    clearTimeout(timer);
    if (paint !== undefined) cancelAnimationFrame(paint);
    block.dispose();
    target = [];
    lines = [];
    groups = [];
  });
  const valid = () =>
    (props.lang || "text").toLowerCase() === state.lang &&
    props.text.startsWith(state.text);
  return (
    <div
      class="otk-code"
      data-language={props.lang || "text"}
      data-numbered={props.lineNumbers ? "true" : "false"}
    >
      <Show when={props.lineNumbers}>
        <pre
          class="otk-code-numbers"
          aria-hidden="true"
        >{props.text.split("\n").map((_, i) => i + 1).join("\n")}</pre>
      </Show>
      <pre><code><Show when={valid()} fallback={<span class="otk-code-plain">{props.text}</span>}>
        <For each={state.groups} keyed={false}>{(group) => <For each={group().lines} keyed={false}>{(line) => <TokenLine line={line()} tail={!line().newline && line().end === state.length ? props.text.slice(state.length) : ""} />}</For>}</For>
        <Show when={!state.groups.length || state.groups.at(-1)!.lines.at(-1)!.newline}><span class="otk-code-plain">{props.text.slice(state.length)}</span></Show>
      </Show></code></pre>
      <Show when={error()}>
        <small class="otk-muted">{error()}</small>
      </Show>
    </div>
  );
}
