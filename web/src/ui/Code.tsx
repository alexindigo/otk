// SPDX-License-Identifier: LGPL-3.0-only
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  For,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { highlightBlock } from "../highlight/client.ts";
import {
  CodeProjection,
  type SourceGroup,
  sourceRange,
} from "../highlight/lines.ts";
import type { HighlightToken } from "../highlight/types.ts";
import CodeGroup from "./CodeGroup.tsx";
interface SourcePiece {
  key: number;
  start: number;
  end: number;
  group?: SourceGroup;
}
function RawSource(props: {
  text: string;
  source: string;
  start: number;
  terminal: boolean;
  mount(selected: () => boolean): () => void;
  onDemand(range?: { start: number; end: number }): void;
  onSelection(): void;
}) {
  let element!: HTMLSpanElement;
  let previous = "", fragments: readonly { text: string }[] = [];
  const parts = createMemo(() => {
    const text = props.text;
    if (!text.startsWith(previous) || !fragments.length) {
      fragments = Object.freeze([Object.freeze({ text })]);
    } else if (text.length > previous.length) {
      fragments = Object.freeze([
        ...fragments,
        Object.freeze({ text: text.slice(previous.length) }),
      ]);
    }
    previous = text;
    return fragments;
  });
  onSettled(() => {
    const selected = () => {
      const selection = document.getSelection();
      return element.contains(selection?.anchorNode || null) ||
        element.contains(selection?.focusNode || null);
    };
    const release = props.mount(selected);
    let pinned = selected(), disposed = false;
    const select = () => {
      const next = selected();
      if (next === pinned) return;
      pinned = next;
      props.onSelection();
    };
    const demand = (rect: DOMRectReadOnly) => {
      if (disposed) return;
      const left = rect.left, right = rect.right;
      const top = rect.top, bottom = rect.bottom;
      if (right <= left || bottom <= top || !document.caretPositionFromPoint) {
        props.onDemand();
        return;
      }
      const position = document.caretPositionFromPoint(
        (left + right) / 2,
        (top + bottom) / 2,
      );
      if (
        !position || position.offsetNode.nodeType !== Node.TEXT_NODE ||
        !element.contains(position.offsetNode)
      ) return;
      const before = document.createRange();
      before.setStart(element, 0);
      before.setEnd(position.offsetNode, position.offset);
      props.onDemand(
        sourceRange(props.source, props.start + before.toString().length),
      );
    };
    const intersection = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === element) demand(entry.intersectionRect);
      }
    });
    const refresh = () => {
      if (disposed) return;
      intersection.unobserve(element);
      intersection.observe(element);
    };
    const observer = new ResizeObserver(refresh);
    observer.observe(element);
    intersection.observe(element);
    document.addEventListener("scroll", refresh, {
      capture: true,
      passive: true,
    });
    document.addEventListener("selectionchange", select);
    return () => {
      disposed = true;
      observer.disconnect();
      intersection.disconnect();
      document.removeEventListener("scroll", refresh, true);
      document.removeEventListener("selectionchange", select);
      release();
    };
  });
  return (
    <>
      <span
        class="otk-code-plain"
        ref={(el) => {
          element = el;
        }}
      >
        <For each={parts()} keyed={(fragment) => fragment}>
          {(fragment) => <>{untrack(fragment).text}</>}
        </For>
      </span>
      <Show when={props.terminal && /[\r\n]$/.test(props.text)}>
        <span class="otk-code-line" />
      </Show>
    </>
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
  const block = highlightBlock(
    untrack(() => (props.lang || "text").toLowerCase()),
    untrack(() => props.text),
  );
  const [rawTick, setRawTick] = createSignal(0);
  const [selectionTick, setSelectionTick] = createSignal(0);
  const [styles, setStyles] = createStore<
    Record<number, { owner: number; tokens: HighlightToken[][] } | undefined>
  >({});
  const [error, setError] = createSignal("");
  const input = createMemo(() =>
    Object.freeze({
      text: props.text,
      lang: (props.lang || "text").toLowerCase(),
      streaming: props.streaming ?? false,
    })
  );
  const tails = new Map<number, () => boolean>();
  const tailFocus = new Map<
    number,
    { owner: number; start: number; end: number }
  >();
  let requested: { owner: number; start: number } | undefined;
  let model = new CodeProjection("", "text");
  let displayedGroups: readonly SourceGroup[] = [];
  let displayedSource = "";
  const tailSelected = () => [...tails.values()].some((selected) => selected());
  // This computation participates in the same render frame as new sibling
  // blocks. It performs one bounded source operation; no post-commit setter can
  // leave an appended suffix missing while the sibling paragraph is visible.
  const frame = createMemo(() => {
    const value = input();
    rawTick();
    selectionTick();
    const compatible = value.text.startsWith(displayedSource);
    if (value.lang !== model.lang || !model.append(value.text)) {
      model = new CodeProjection(value.text, value.lang, model);
    }
    if (!compatible) displayedGroups = [];
    const pinned = compatible && tailSelected();
    let group: SourceGroup | undefined;
    if (requested?.owner === model.id && !pinned) {
      group = model.reserve(requested.start);
      requested = undefined;
    } else if (!model.complete) {
      const built = model.build();
      if (!displayedGroups.length) group = built?.group;
    }
    const next = displayedGroups.map((shown) =>
      model.groups.find((candidate) => candidate.key === shown.key) ?? shown
    );
    if (!pinned) {
      if (group) {
        const index = next.findIndex((shown) => shown.key === group!.key);
        if (index < 0) next.push(group);
        else next[index] = group;
      }
    }
    displayedGroups = Object.freeze(next.sort((a, b) => a.start - b.start));
    displayedSource = value.text;
    return Object.freeze({
      model,
      source: value.text,
      complete: model.complete,
      groups: displayedGroups,
    });
  });
  let disposed = false,
    scheduled = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, deadline = 0;
  let desired:
    | { value: ReturnType<typeof input>; model: CodeProjection }
    | undefined;
  const warm = new Set<number>();
  const projections = new Map<
    number,
    { owner: number; tokens: HighlightToken[] }
  >();
  const updateFocus = () => {
    if (disposed) return;
    const current = frame(), owner = current.model;
    const ranges = current.groups.filter((group) => warm.has(group.key)).map((
      group,
    ) => ({
      start: group.start,
      end: group.end,
    }));
    for (const focus of tailFocus.values()) {
      if (
        focus.owner === owner.id &&
        !ranges.some((range) => range.start === focus.start)
      ) {
        ranges.push({ start: focus.start, end: focus.end });
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    block.focus(ranges);
  };
  const mountTail = (key: number, selected: () => boolean) => {
    tails.set(key, selected);
    return () => {
      tails.delete(key);
      tailFocus.delete(key);
      updateFocus();
    };
  };
  const demandTail = (key: number, range?: { start: number; end: number }) => {
    if (disposed) return;
    if (range) {
      const current = frame(), owner = current.model.id;
      tailFocus.set(key, { owner, ...range });
      if (!current.groups.some((group) => group.start === range.start)) {
        requested = { owner, start: range.start };
        enqueue();
      }
    } else tailFocus.delete(key);
    updateFocus();
  };
  const channel = new MessageChannel();
  const enqueue = () => {
    if (!disposed && !scheduled) {
      scheduled = true;
      channel.port2.postMessage(null);
    }
  };
  channel.port1.onmessage = () => {
    scheduled = false;
    if (disposed) return;
    const current = frame(), owner = current.model;
    for (const [start, projection] of projections) {
      if (projection.owner !== owner.id) {
        projections.delete(start);
        continue;
      }
      const group = current.groups.find((group) => group.start === start);
      if (!group || !warm.has(group.key)) continue;
      projections.delete(start);
      const tokens = owner.projectSource(group, start, projection.tokens);
      if (!tokens) continue;
      setStyles((draft) => {
        draft[group.key] = { owner: owner.id, tokens };
      });
      enqueue();
      return;
    }
    // Styles are a group projection, not a prerequisite for source layout.
    for (const group of current.groups) {
      const index = owner.groups.findIndex((candidate) =>
        candidate.key === group.key
      );
      if (
        !warm.has(group.key) ||
        (index >= 0
          ? !owner.dirty.has(index)
          : styles[group.key]?.owner === owner.id)
      ) continue;
      if (index >= 0) owner.dirty.delete(index);
      const tokens = owner.project(group);
      if (tokens) {
        setStyles((draft) => {
          draft[group.key] = { owner: owner.id, tokens };
        });
        enqueue();
        return;
      }
    }
    if (!owner.complete || (requested?.owner === owner.id && !tailSelected())) {
      setRawTick((value) => value + 1);
      enqueue();
    }
  };
  const capture = () => {
    timer = undefined;
    if (disposed || !desired) return;
    if (Date.now() < deadline) {
      schedule();
      return;
    }
    const { value, model: owner } = desired;
    desired = undefined;
    const id = ++generation;
    updateFocus();
    void block.capture({
      generation: id,
      lang: value.lang,
      text: value.text,
      streaming: value.streaming,
    }, (chunk) => {
      if (
        disposed || frame().model !== owner ||
        !owner.source.startsWith(value.text)
      ) return;
      // Worker and cached progress are bounded; there is no per-prefix ack.
      for (
        const _ of owner.accept(
          value.lang,
          value.text,
          chunk.from,
          chunk.tokens,
        )
      ) { /* one bounded result */ }
      enqueue();
    }, (chunk) => {
      if (
        disposed || frame().model !== owner ||
        !owner.source.startsWith(value.text)
      ) return;
      projections.set(chunk.start, { owner: owner.id, tokens: chunk.tokens });
      enqueue();
    }).then(() => {
      if (!disposed && id === generation && frame().model === owner) {
        setError("");
      }
    }).catch((error) => {
      if (
        !disposed && id === generation && frame().model === owner &&
        error.name !== "AbortError"
      ) setError(error.message || "Highlighting unavailable");
    });
  };
  const schedule = () => {
    if (disposed || !desired || timer !== undefined) return;
    timer = setTimeout(capture, Math.max(0, deadline - Date.now()));
  };
  createEffect(
    () => ({ value: input(), owner: frame().model }),
    ({ value, owner }, previous) => {
      if (previous?.value === value && previous.owner === owner) return;
      if (previous && previous.owner !== owner) block.cancel();
      if (!previous || previous.value.lang !== value.lang) {
        void block.prepare(value.lang, value.text).catch((error) => {
          if (
            !disposed && frame().model === owner && error.name !== "AbortError"
          ) setError(error.message);
        });
      }
      enqueue();
      if (!desired) deadline = Date.now() + 50;
      desired = { value, model: owner };
      schedule();
    },
  );
  const demand = (key: number, visible: boolean) => {
    if (disposed) return;
    if (visible) {
      warm.add(key);
      const owner = frame().model,
        index = owner.groups.findIndex((group) => group.key === key);
      if (index >= 0) owner.dirty.add(index);
      enqueue();
    } else {
      warm.delete(key);
      setStyles((draft) => {
        delete draft[key];
      });
    }
    updateFocus();
  };
  onSettled(() => {
    return () => {
      disposed = true;
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      block.dispose();
      desired = undefined;
      warm.clear();
      projections.clear();
      tails.clear();
      tailFocus.clear();
      requested = undefined;
    };
  });
  const pieces = createMemo(() => {
    const current = frame();
    const result: SourcePiece[] = [];
    let start = 0;
    for (const group of current.groups) {
      if (group.start > start) {
        result.push({ key: -start - 1, start, end: group.start });
      }
      result.push({
        key: group.key,
        start: group.start,
        end: group.end,
        group,
      });
      start = group.end;
    }
    if (
      start < current.source.length ||
      (!current.complete && current.groups.at(-1)?.rows.at(-1)?.newline)
    ) result.push({ key: -start - 1, start, end: current.source.length });
    return result;
  });
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
        >{props.text.split(/\r\n|\n|\r/).map((_, i) => i + 1).join("\n")}</pre>
      </Show>
      <pre><code>
      <For each={pieces()} keyed={piece => piece.key}>{piece => (
        <Show when={piece().group} fallback={<RawSource text={frame().source.slice(piece().start, piece().end)} source={frame().source} start={piece().start} terminal={piece().end === frame().source.length} mount={selected => mountTail(piece().key, selected)} onDemand={range => demandTail(piece().key, range)} onSelection={() => { setSelectionTick(value => value + 1); enqueue(); }} />}>
          {group => <CodeGroup rows={group().rows} tokens={styles[group().key]?.owner === frame().model.id ? styles[group().key]?.tokens : undefined} onDemand={visible => demand(group().key, visible)} />}
        </Show>
      )}</For>
    </code></pre>
      <Show when={error()}>
        <small class="otk-muted">{error()}</small>
      </Show>
    </div>
  );
}
