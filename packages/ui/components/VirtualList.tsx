// SPDX-License-Identifier: LGPL-3.0-only
import "./VirtualList.css" with { type: "text" };
import { createWindow, type WindowAnchor } from "@otk/client";
import {
  createEffect,
  createMemo,
  createSignal,
  type Element,
  For,
  onCleanup,
  onSettled,
  untrack,
} from "solid-js";

export interface VirtualListControl {
  reveal(key: string): void;
}
export const LIST_OVERSCAN = 5;
/** A measured, normal-flow viewport. Keys/content/role samples are consumer inputs. */
export default function VirtualList(props: {
  keys: readonly string[];
  label: string;
  class?: string;
  samples: readonly { role: string; class: string }[];
  role(key: string): string;
  render(key: string): Element;
  itemAttributes?(key: string): Record<string, unknown>;
  pinned?: readonly string[];
  position?: { scrollTop: number; anchor?: WindowAnchor };
  onPosition?(position: { scrollTop: number; anchor?: WindowAnchor }): void;
  control?(control: VirtualListControl): void;
}): Element {
  const model = createWindow();
  const [top, setTop] = createSignal(0),
    [height, setHeight] = createSignal(0),
    [version, setVersion] = createSignal(0);
  const [focus, setFocus] = createSignal<string>(),
    [contexts, setContexts] = createSignal<string[]>([]);
  const [ready, setReady] = createSignal(false);
  const estimates = new Map<string, number>(),
    elements = new Map<string, HTMLElement>();
  const samples = new Map<string, HTMLElement>();
  let viewport!: HTMLDivElement,
    observer: ResizeObserver | undefined,
    currentKeys: readonly string[] | undefined;
  const remember = () =>
    props.onPosition?.({
      scrollTop: viewport.scrollTop,
      anchor: model.anchor(viewport.scrollTop),
    });
  const scroll = (value: number) => {
    viewport.scrollTop = value;
    setTop(viewport.scrollTop);
  };
  const refresh = () => setVersion((v) => v + 1);
  createEffect(
    () => ({
      keys: props.keys,
      ready: ready(),
      pins: [
        ...props.pinned ?? [],
        ...contexts(),
        ...focus() ? [focus()!] : [],
      ],
    }),
    ({ keys, ready, pins }) => {
      if (!ready) return;
      // Search can remove an interacting key from the projection. Its mounted
      // lifetime stays until the owning focus/editor/menu releases it.
      const next = [...keys], included = new Set(keys), held = new Set(pins);
      for (const key of currentKeys ?? []) {
        if (held.has(key) && !included.has(key)) next.push(key);
      }
      if (
        currentKeys?.length === next.length &&
        currentKeys.every((key, i) => key === next[i])
      ) return;
      const anchor = currentKeys
        ? model.anchor(viewport.scrollTop)
        : props.position?.anchor;
      const fallback = currentKeys
        ? viewport.scrollTop
        : props.position?.scrollTop ?? 0;
      model.update(next, (key) => estimates.get(props.role(key)) ?? 1);
      currentKeys = next;
      // Scroll after the new spacers are painted, never let native anchoring compete.
      refresh();
      const value = model.restore(anchor) ?? fallback;
      setTop(
        Math.min(value, Math.max(0, model.total() - viewport.clientHeight)),
      );
    },
  );
  const range = createMemo(() => {
    void version();
    return model.range(top(), height(), LIST_OVERSCAN, [
      ...props.pinned ?? [],
      ...contexts(),
      ...focus() ? [focus()!] : [],
    ]);
  });
  const items = createMemo(() => {
    void version();
    let end = 0;
    return range().visibleKeys.map((key) => {
      const start = model.offset(key)!;
      const item = { key, before: start - end };
      end = start + model.size(key);
      return item;
    });
  });
  const after = () => {
    void version();
    const last = range().visibleKeys.at(-1);
    return last
      ? model.total() - model.offset(last)! - model.size(last)
      : model.total();
  };
  createEffect(() => ({ top: top(), version: version() }), ({ top }) => {
    if (viewport) viewport.scrollTop = top;
  });
  const keyFor = (target: EventTarget | null) =>
    target instanceof HTMLElement
      ? target.closest<HTMLElement>("[data-virtual-key]")?.dataset.virtualKey
      : undefined;
  props.control?.({
    reveal(key) {
      const start = model.offset(key);
      if (start === undefined) return;
      const end = start + model.size(key);
      scroll(
        start < viewport.scrollTop
          ? start
          : end > viewport.scrollTop + viewport.clientHeight
          ? end - viewport.clientHeight
          : viewport.scrollTop,
      );
      remember();
    },
  });
  onSettled(() => {
    for (const [role, element] of samples) {
      estimates.set(role, element.getBoundingClientRect().height);
    }
    setHeight(viewport.clientHeight);
    setReady(true);
    observer = new ResizeObserver((entries) => {
      const anchor = model.anchor(viewport.scrollTop);
      let changed = false;
      for (const entry of entries) {
        if (entry.target === viewport) {
          setHeight(viewport.clientHeight);
          continue;
        }
        const key = (entry.target as HTMLElement).dataset.virtualKey;
        if (key) {
          changed =
            model.measure(key, entry.target.getBoundingClientRect().height) ||
            changed;
        }
      }
      if (changed) {
        const value = model.restore(anchor);
        refresh();
        if (value !== undefined) setTop(value);
      }
    });
    observer.observe(viewport);
    for (const element of elements.values()) observer.observe(element);
    const retain = (event: Event) => {
      const key = keyFor(event.target);
      if (!key) return;
      setContexts((keys) => [...keys, key]);
      (event as CustomEvent<{ release: (() => void)[] }>).detail.release.push(
        () => setContexts((keys) => keys.filter((k) => k !== key)),
      );
    };
    viewport.addEventListener("otk-context-retain", retain);
    return () => {
      remember();
      observer?.disconnect();
      viewport.removeEventListener("otk-context-retain", retain);
    };
  });
  function Item(input: { key: string }) {
    let element!: HTMLDivElement;
    // Construct once for this keyed lifetime; only the injected view's nested
    // bindings observe live data. Re-running a render callback replaces focus.
    const content = untrack(() => props.render(input.key));
    onSettled(() => {
      elements.set(input.key, element);
      observer?.observe(element);
      return () => {
        observer?.unobserve(element);
        elements.delete(input.key);
      };
    });
    return (
      <div
        ref={element}
        data-virtual-key={input.key}
        class="otk-virtual-item"
        role="listitem"
        {...props.itemAttributes?.(input.key)}
      >
        {content}
      </div>
    );
  }
  onCleanup(() => {
    elements.clear();
  });
  return (
    <div
      ref={viewport}
      class={`otk-virtual-list ${props.class ?? ""}`}
      role="list"
      aria-label={props.label}
      onScroll={() => {
        setTop(viewport.scrollTop);
        remember();
      }}
      onFocusIn={(event) => setFocus(keyFor(event.target))}
      onFocusOut={() =>
        queueMicrotask(() => {
          if (viewport.isConnected) {
            setFocus(
              viewport.contains(document.activeElement)
                ? keyFor(document.activeElement)
                : undefined,
            );
          }
        })}
    >
      <div class="otk-virtual-measure" aria-hidden="true">
        <For each={props.samples} keyed={(s) => s.role}>
          {(sample) => (
            <div
              ref={(element) => samples.set(sample().role, element)}
              class={sample().class}
            />
          )}
        </For>
      </div>
      <For each={items()} keyed={(item) => item.key}>
        {(item) => (
          <>
            <div
              class="otk-virtual-space"
              aria-hidden="true"
              style={{ height: `${item().before}px` }}
            />
            <Item key={item().key} />
          </>
        )}
      </For>
      <div
        class="otk-virtual-space"
        aria-hidden="true"
        style={{ height: `${after()}px` }}
      />
    </div>
  );
}
