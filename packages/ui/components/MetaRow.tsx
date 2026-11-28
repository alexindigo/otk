// SPDX-License-Identifier: LGPL-3.0-only
import {
  createMemo,
  createSignal,
  type Element,
  For,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import ContentSlot from "./ContentSlot.tsx";
import "./ChromeMeta.css" with { type: "text" };

export interface MetaControl {
  key: string;
  measure(): Element;
  render(): Element;
}

/** One whole fact. Higher ranks yield first. */
export function MetaItem(props: {
  rank: number;
  class?: string;
  compact?: Element;
  /** This item has a compact label inside the same focusable control. */
  compactInPlace?: boolean;
  /** Compact when necessary, but never remove this affordance. */
  required?: boolean;
  children: Element;
  title?: string;
  "aria-label"?: string;
}): Element {
  return (
    <span
      class={["otk-meta-item", props.class]}
      data-meta-rank={props.rank}
      data-meta-required={props.required ? "" : undefined}
      data-meta-compact={props.compactInPlace ? "" : undefined}
      title={props.title}
      aria-label={props["aria-label"]}
    >
      <span class="otk-meta-full">{props.children}</span>
      <Show when={props.compact}>
        <span class="otk-meta-compact" aria-hidden="true">{props.compact}</span>
      </Show>
    </span>
  );
}

/** One metadata track. Text yields first; optional controls fit only as wholes. */
export function MetaRow(
  props: {
    children?: Element;
    class?: string;
    controls?: readonly MetaControl[];
    whole?: boolean;
    intrinsic?: boolean;
  },
): Element {
  let root!: HTMLSpanElement, primary!: HTMLSpanElement;
  const frames = new Map<string, HTMLSpanElement>();
  const [visible, setVisible] = createSignal<readonly string[]>([]);
  let observer: ResizeObserver | undefined;
  const fit = () => {
    if (!primary) return;
    const gap = parseFloat(getComputedStyle(root).columnGap) || 0;
    primary.classList.add("is-measuring-minimum");
    const minimum = primary.getBoundingClientRect().width;
    primary.classList.remove("is-measuring-minimum");
    let available = root.clientWidth - minimum;
    const next: string[] = [];
    for (const control of props.controls ?? []) {
      const width = frames.get(control.key)?.getBoundingClientRect().width ??
        Infinity;
      if (width + gap > available) break;
      available -= width + gap;
      next.push(control.key);
    }
    setVisible((old) => old.join("\0") === next.join("\0") ? old : next);
  };
  const controls = createMemo(() => props.controls ?? []);
  onSettled(() => {
    if (props.whole) {
      const items = new Set<HTMLElement>();
      const fitItems = () => {
        // An ancestor can hide this whole row (for example a folded footer).
        // Keep its intrinsic contribution ready for the next visible layout.
        if (!root.getClientRects().length) return;
        const gap = parseFloat(getComputedStyle(root).columnGap) || 0;
        const children = Array.from(root.children).filter((item) =>
          item instanceof HTMLElement
        );
        const byYield = children.map((item, index) => ({
          item,
          rank: Number(item.dataset.metaRank ?? index + 1),
          required: item.hasAttribute("data-meta-required"),
          index,
        })).sort((a, b) => b.rank - a.rank || b.index - a.index);
        for (const item of children) {
          item.hidden = false;
          item.classList.remove("is-compact");
        }
        const widths = new Map(children.map((item) => [
          item,
          item.getBoundingClientRect().width,
        ]));
        const total = () => {
          const visible = [...widths.values()];
          return visible.reduce((sum, width) => sum + width, 0) +
            Math.max(0, visible.length - 1) * gap;
        };
        if (props.intrinsic) {
          root.style.setProperty("--meta-intrinsic", `${total()}px`);
        }
        const available = root.getBoundingClientRect().width;
        const overflows = () => total() > available + 0.5;
        const compact = (item: HTMLElement) => {
          if (
            item.hasAttribute("data-meta-compact") ||
            item.querySelector(":scope > .otk-meta-compact")
          ) {
            item.classList.add("is-compact");
            widths.set(item, item.getBoundingClientRect().width);
          }
        };
        for (const { item, required } of byYield) {
          if (!overflows()) return;
          if (!required) compact(item);
        }
        for (const { item, required } of byYield) {
          if (!overflows()) return;
          if (required) compact(item);
          else {
            item.hidden = true;
            widths.delete(item);
          }
        }
      };
      const resize = new ResizeObserver(fitItems);
      const update = () => {
        for (const item of items) {
          if (item.parentElement !== root) {
            resize.unobserve(item);
            items.delete(item);
          }
        }
        for (const item of root.children) {
          if (!(item instanceof HTMLElement) || items.has(item)) continue;
          items.add(item);
          resize.observe(item);
        }
        fitItems();
      };
      const mutation = new MutationObserver(update);
      resize.observe(root);
      mutation.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      update();
      return () => {
        resize.disconnect();
        mutation.disconnect();
      };
    }
    if (!props.controls) return;
    observer = new ResizeObserver(fit);
    observer.observe(root);
    observer.observe(primary);
    for (const frame of frames.values()) observer.observe(frame);
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) fit();
    });
    fit();
    return () => {
      active = false;
      observer?.disconnect();
    };
  });
  return (
    <span
      ref={(element) => root = element}
      class={["otk-meta-row", props.class, {
        "has-controls": props.controls !== undefined,
        "fits-whole-items": props.whole,
        "has-intrinsic": props.intrinsic,
      }]}
    >
      <Show when={props.controls} fallback={props.children}>
        <span class="otk-meta-fit">
          <span class="otk-meta-primary" ref={(element) => primary = element}>
            {props.children}
          </span>
          <For each={controls()} keyed={(item) => item.key}>
            {(item) => (
              <span
                class="otk-meta-control"
                hidden={!visible().includes(item().key)}
                inert={!visible().includes(item().key)}
              >
                <ContentSlot content={() => item().render()} />
              </span>
            )}
          </For>
        </span>
        <span class="otk-meta-measure" aria-hidden="true" inert>
          <For each={controls()} keyed={(item) => item.key}>
            {(item) => {
              const key = item().key;
              let frame: HTMLSpanElement;
              onCleanup(() => {
                if (frame) observer?.unobserve(frame);
                frames.delete(key);
              });
              return (
                <span
                  ref={(element) => {
                    frame = element;
                    frames.set(key, element);
                    observer?.observe(element);
                  }}
                >
                  <ContentSlot content={() => item().measure()} />
                </span>
              );
            }}
          </For>
        </span>
      </Show>
    </span>
  );
}

/** Quiet product-owned chrome metadata, shared with the project's visit clock. */
