// SPDX-License-Identifier: LGPL-3.0-only
import "./VirtualList.css" with { type: "text" };
import { scrollRegion } from "./ScrollRegion.tsx";
import { isCancellation } from "@otk/protocol";
import { createWindow, type WindowAnchor } from "@otk/client";
import { acquireViewport, type ViewportPosition } from "./viewport.ts";
import { nativeAttributes } from "./native-attributes.ts";
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type Element,
  flush,
  For,
  onCleanup,
  onSettled,
  Show,
  untrack,
  useContext,
} from "solid-js";

export interface VirtualListControl {
  restore(anchor: WindowAnchor): Promise<void>;
  reveal(
    key: string,
    options?: { align?: "center" | "nearest"; focus?: () => void },
  ): Promise<void>;
  anchor(): WindowAnchor | undefined;
}
export const LIST_OVERSCAN = 5;
interface WindowContext {
  element(): HTMLElement | undefined;
  materialized(): boolean;
  path: string;
  measurements(path: string): Map<string, number>;
  materializers: Set<() => boolean>;
  hold?(): () => void;
  pin?(): () => void;
}
const Viewport = createContext<WindowContext | null>(null);
/** Reuse the enclosing viewport; nested windows never make nested scroll boxes. */
export function useVirtualViewport() {
  return useContext(Viewport);
}
/** Content borrows a viewport when supplied, remaining reusable in normal flow. */
export function ContentWindow<T>(props: {
  items: readonly T[];
  key(value: T): string;
  label: string;
  scope?: string;
  role?: "content" | "segment" | "line" | "metadata";
  control?(control: VirtualListControl): void;
  render(value: () => T): Element;
}) {
  const viewport = useContext(Viewport);
  const indexed = createMemo(() =>
    new Map(props.items.map((value) => [props.key(value), value]))
  );
  const keys = createMemo(() => [...indexed().keys()]);
  return (
    <Show
      when={viewport}
      fallback={
        <For each={props.items} keyed={props.key}>
          {(value) => props.render(value)}
        </For>
      }
    >
      <VirtualList
        keys={keys()}
        label={props.label}
        scope={props.scope}
        samples={[{
          role: "content",
          class: `otk-window-${props.role ?? "content"}-estimate`,
        }]}
        role={() => "content"}
        overscan={0}
        retainExcluded={false}
        control={props.control}
        revision={indexed()}
        render={(key) => (
          <Show when={indexed().get(key)}>
            {(value) => props.render(value)}
          </Show>
        )}
      />
    </Show>
  );
}
const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Measured identity geometry, shared by lists, transcripts and part collections. */
export default function VirtualList(props: {
  keys: readonly string[];
  label: string;
  scope?: string;
  class?: string;
  samples?: readonly { role: string; class: string }[];
  role?(key: string): string;
  estimate?: number;
  retainExcluded?: boolean;
  measurements?(path: string): Map<string, number>;
  revision?: unknown;
  overscan?: number;
  viewport?(): HTMLElement | undefined;
  render(key: string): Element;
  itemAttributes?(key: string): Record<string, unknown>;
  pinned?: readonly string[];
  position?: { scrollTop: number; anchor?: WindowAnchor };
  onPosition?(position: { scrollTop: number; anchor?: WindowAnchor }): void;
  onRange?(keys: readonly string[]): void;
  onPins?(keys: readonly string[]): (() => void) | void;
  control?(control: VirtualListControl): void;
}): Element {
  const parent = useContext(Viewport);
  const initialPosition = untrack(() =>
    props.position &&
    ({ scrollTop: props.position.scrollTop, anchor: props.position.anchor })
  );
  let restoring = !!initialPosition;
  const borrowed = !!props.viewport || !!parent;
  const materializers = parent?.materializers ?? new Set<() => boolean>();
  const windows = new Map<string, Map<string, number>>();
  const measurements = props.measurements ?? parent?.measurements ??
    ((path: string) => {
      let sizes = windows.get(path);
      if (!sizes) {
        sizes = new Map();
        windows.set(path, sizes);
      }
      return sizes;
    });
  const path = `${parent?.path ?? ""}/${
    encodeURIComponent(props.scope ?? props.label)
  }`;
  const model = createWindow(measurements(path));
  const [top, setTop] = createSignal(0), [height, setHeight] = createSignal(0);
  const [version, setVersion] = createSignal(0),
    [ready, setReady] = createSignal(false);
  const [focus, setFocus] = createSignal<string>(),
    [contexts, setContexts] = createSignal<string[]>([]);
  const contextLeases = new Map<string, number>();
  const [selected, setSelected] = createSignal<string[]>([]),
    [reveals, setReveals] = createSignal<string[]>([]);
  const [attachments, setAttachments] = createSignal<string[]>([]);
  const attachmentLeases = new Map<string, number>();
  const [all, setAll] = createSignal<readonly string[]>();
  const materialized = () => !!all() || !!parent?.materialized();
  const estimates = new Map<string, number>(),
    elements = new Map<string, HTMLElement>();
  const samples = new Map<string, HTMLElement>();
  let container!: HTMLDivElement, observer: ResizeObserver | undefined;
  let focusMoves: MutationObserver | undefined;
  let focusedControl: HTMLElement | undefined;
  let currentKeys: readonly string[] | undefined, disposed = false;
  let positionOwner: ViewportPosition | undefined;
  const measuring = new Map<string, number>();
  let measureFrame: number | undefined;
  let releaseParentMeasurement = parent?.hold?.();
  let releaseGeometryMeasurement: (() => void) | undefined;
  let selectingAll = false;
  const materializedReady = () =>
    !materialized() ||
    (ready() && (all() ?? props.keys).every((key) => elements.has(key)));
  materializers.add(materializedReady);
  const viewport = () => props.viewport?.() ?? parent?.element() ?? container;
  const origin = () =>
    borrowed
      ? container.getBoundingClientRect().top -
        viewport().getBoundingClientRect().top + viewport().scrollTop -
        viewport().clientTop
      : 0;
  const position = () => viewport().scrollTop - origin();
  const rowStart = (key: string) => {
    const element = elements.get(key), root = viewport();
    if (element?.isConnected) {
      return element.getBoundingClientRect().top -
        root.getBoundingClientRect().top + root.scrollTop - root.clientTop;
    }
    const offset = model.offset(key);
    return offset === undefined ? undefined : origin() + offset;
  };
  const logicalAnchor = () => {
    const root = viewport(), bounds = root.getBoundingClientRect();
    const candidates = [...elements].flatMap(([key, element]) => {
      if (!element.isConnected || measuring.has(key) || !model.measured(key)) {
        return [];
      }
      const rect = element.getBoundingClientRect();
      if (
        !rect.height || rect.bottom <= bounds.top + root.clientTop ||
        rect.top >= bounds.top + root.clientTop + root.clientHeight ||
        Math.abs(rect.height - model.size(key)) > .01
      ) return [];
      const offset = bounds.top + root.clientTop - rect.top;
      return [{ key, offset }];
    }).sort((a, b) => Math.max(0, -a.offset) - Math.max(0, -b.offset));
    return candidates[0];
  };
  const transaction = (change: () => void) => {
    if (!positionOwner) return change();
    const owner = positionOwner;
    owner.transaction(() => {
      change();
      // Prefix updates and their keyed DOM must be one layout revision. Solid
      // drains synchronously at native measurement boundaries; inside an effect
      // its settled callback joins the already-running reconciliation instead.
      flush();
      onSettled(() => {
        if (!disposed) owner.transaction(() => {});
      });
    });
  };
  const beginMeasurement = () => {
    releaseParentMeasurement ??= parent?.hold?.();
    releaseGeometryMeasurement ??= positionOwner?.hold();
  };
  const pin = (key: string) => {
    const count = attachmentLeases.get(key) ?? 0;
    attachmentLeases.set(key, count + 1);
    if (!count) setAttachments([...attachmentLeases.keys()]);
    const releaseParent = parent?.pin?.();
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const count = (attachmentLeases.get(key) ?? 1) - 1;
      if (count) attachmentLeases.set(key, count);
      else {
        attachmentLeases.delete(key);
        if (!disposed) setAttachments([...attachmentLeases.keys()]);
      }
      releaseParent?.();
    };
  };
  const refresh = () => setVersion((v) => v + 1);
  function queueMeasurement() {
    if (disposed || measureFrame !== undefined) return;
    measureFrame = requestAnimationFrame(() => {
      measureFrame = undefined;
      if (disposed) return;
      transaction(() => {
        let changed = false,
          released = false,
          pending = !ready() || !currentKeys;
        for (const [key, count] of measuring) {
          if (count > 0) continue;
          const element = elements.get(key);
          if (element?.isConnected) {
            changed =
              model.measure(key, element.getBoundingClientRect().height) ||
              changed;
            measuring.delete(key);
            released = true;
          } else if (!props.keys.includes(key)) {
            measuring.delete(key);
            released = true;
          } else pending = true;
        }
        if (changed || released) refresh();
        sync();
        if (
          ready() && currentKeys && !measuring.size &&
          range().visibleKeys.every((key) =>
            elements.has(key) && model.measured(key)
          )
        ) {
          const release = releaseParentMeasurement;
          releaseParentMeasurement = undefined;
          const releaseGeometry = releaseGeometryMeasurement;
          releaseGeometryMeasurement = undefined;
          release?.();
          releaseGeometry?.();
        } else pending = true;
        remember();
        if (pending) queueMeasurement();
      });
    });
  }
  function holdMeasurement(key: string): () => void {
    beginMeasurement();
    measuring.set(key, (measuring.get(key) ?? 0) + 1);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      if (!disposed) {
        const count = (measuring.get(key) ?? 1) - 1;
        measuring.set(key, count);
        queueMeasurement();
      }
    };
  }
  const changing = (revision = false) => {
    beginMeasurement();
    if (revision) {
      // A zero-height source cannot intersect a future range while unmounted.
      // Its content revision revokes that old measurement and restores demand
      // geometry, allowing empty streaming/bookkeeping rows to acquire content.
      let invalidated = false;
      for (const key of currentKeys ?? []) {
        if (model.measured(key) && model.size(key) === 0) {
          invalidated = model.invalidate(key) || invalidated;
        }
      }
      if (invalidated) {
        refresh();
        sync();
      }
    }
    for (const key of elements.keys()) {
      if (!measuring.has(key)) measuring.set(key, 0);
    }
    queueMeasurement();
  };
  createEffect(() => props.revision, () => transaction(() => changing(true)));
  const remember = () => {
    if (!currentKeys || restoring || disposed || !container.isConnected) return;
    props.onPosition?.({
      scrollTop: position(),
      anchor: logicalAnchor(),
    });
  };
  const sync = () => {
    if (disposed || !container) return;
    const local = position(), root = viewport();
    const available = root.clientHeight + Math.min(0, local);
    const remaining = model.total() - Math.max(0, local);
    setTop(Math.max(0, local));
    setHeight(
      Math.max(
        0,
        Math.min(
          available,
          // A zero-size collection inside the viewport still has a demanded
          // boundary. Keep its frontier mounted so it can acquire content.
          remaining === 0 ? available : remaining,
        ),
      ),
    );
  };
  const pins = () => {
    // Range and consumer retention observe the same measurement-lease revision.
    void version();
    return [
      ...props.pinned ?? [],
      ...contexts(),
      ...selected(),
      ...reveals(),
      ...attachments(),
      ...measuring.keys(),
      ...focus() ? [focus()!] : [],
      ...all() ?? (parent?.materialized() ? props.keys : []),
    ];
  };
  let releasePins: (() => void) | undefined;
  let retainedPins: string[] = [];
  createEffect(() => [...new Set(pins())], (keys) => {
    if (
      keys.length === retainedPins.length &&
      keys.every((key, i) => key === retainedPins[i])
    ) return;
    const release = props.onPins?.(keys);
    releasePins?.();
    releasePins = release || undefined;
    retainedPins = keys;
  });
  createEffect(
    () => ({ keys: props.keys, ready: ready(), pins: pins() }),
    ({ keys, ready, pins }) => {
      if (!ready) return;
      const next = [...keys], included = new Set(keys), held = new Set(pins);
      for (
        const key of currentKeys ?? []
      ) {
        if (
          props.retainExcluded !== false && held.has(key) && !included.has(key)
        ) next.push(key);
      }
      if (
        currentKeys?.length === next.length &&
        currentKeys.every((key, i) => key === next[i])
      ) return;
      const initialized = !!currentKeys;
      transaction(() => {
        const previous = currentKeys;
        positionOwner?.remap(path, (anchor) => {
          if (included.has(anchor.key)) return anchor;
          const at = previous?.indexOf(anchor.key) ?? -1;
          const measuredNeighbor = (key: string) =>
            included.has(key) &&
            elements.get(key)?.isConnected && model.measured(key) &&
            !measuring.has(key);
          const neighbor = previous?.slice(at + 1).find((key) =>
            measuredNeighbor(key)
          ) ?? [...previous?.slice(0, at) ?? []].reverse().find((key) =>
            measuredNeighbor(key)
          );
          const base = neighbor ? rowStart(neighbor) : undefined;
          return neighbor && base !== undefined
            ? { key: neighbor, offset: viewport().scrollTop - base }
            : undefined;
        });
        changing();
        model.update(
          next,
          (key) =>
            estimates.get(props.role?.(key) ?? "row") ?? props.estimate ?? 1,
        );
        currentKeys = next;
        refresh();
        sync();
        positionOwner?.layout();
      });
      if (!initialized && initialPosition) {
        void positionOwner?.navigate(() => {
          if (disposed) {
            throw new DOMException("Viewport retired", "AbortError");
          }
          const top = (model.restore(initialPosition.anchor) ??
            initialPosition.scrollTop) + origin();
          return { start: top, end: top, measured: true };
        }, "start").catch((error) => {
          if (!isCancellation(error)) throw error;
        }).finally(() => {
          restoring = false;
          remember();
        });
      }
    },
  );
  const range = createMemo(() => {
    void version();
    return model.range(
      top(),
      height(),
      props.overscan ?? (borrowed ? 0 : LIST_OVERSCAN),
      pins(),
    );
  });
  createEffect(
    () => ({ keys: range().visibleKeys, version: version() }),
    ({ keys }) => props.onRange?.(keys),
  );
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
  const keyFor = (target: EventTarget | null): string | undefined => {
    let element = target instanceof Node
      ? (target instanceof HTMLElement ? target : target.parentElement)
      : null;
    while (element && element !== container) {
      const key = element.dataset.virtualKey;
      if (key && elements.get(key) === element) return key;
      element = element.parentElement;
    }
  };
  const acceptFocus = (target: EventTarget | null) => {
    const key = keyFor(target);
    focusedControl = key && target instanceof HTMLElement ? target : undefined;
    setFocus(key);
  };
  const retainMovedFocus = (records: readonly MutationRecord[]) => {
    const control = focusedControl;
    if (
      !container.isConnected || !control?.isConnected ||
      document.activeElement !== document.body
    ) return;
    // Keyed reconciliation can move a retained row and natively blur its control.
    // A connected move keeps the focus lease; deletion and explicit focus do not.
    if (
      records.some((record) =>
        Array.from(record.removedNodes).some((node) => node.contains(control))
      )
    ) control.focus({ preventScroll: true });
  };
  async function navigateKey(
    key: string,
    align: "center" | "nearest" | "start",
    anchor?: WindowAnchor,
    focus?: () => void,
  ) {
    if (!props.keys.includes(key)) {
      throw new Error("Item is no longer available");
    }
    setReveals((keys) => [...keys, key]);
    try {
      while (!positionOwner && !disposed) await frame();
      if (disposed) throw new DOMException("Viewport retired", "AbortError");
      await positionOwner!.navigate(() => {
        if (disposed) throw new DOMException("Viewport retired", "AbortError");
        if (!props.keys.includes(key)) {
          throw new Error("Item is no longer available");
        }
        const base = rowStart(key);
        if (base === undefined) return;
        const element = elements.get(key), start = base + (anchor?.offset ?? 0);
        return {
          start,
          end: anchor ? start : start + model.size(key),
          measured: !!element?.isConnected && !measuring.has(key) &&
            Math.abs(element.getBoundingClientRect().height - model.size(key)) <
              .01,
          anchor: { id: path, key, start: base },
        };
      }, align);
      focus?.();
    } finally {
      setReveals((keys) => keys.filter((id) => id !== key));
    }
  }
  props.control?.({
    restore: (anchor) => navigateKey(anchor.key, "start", anchor),
    anchor: logicalAnchor,
    reveal: (key, options) =>
      navigateKey(key, options?.align ?? "nearest", undefined, options?.focus),
  });
  onSettled(() => {
    for (const [role, element] of samples) {
      estimates.set(role, element.getBoundingClientRect().height);
    }
    const root = viewport();
    const lease = acquireViewport(root);
    positionOwner = lease.owner;
    beginMeasurement();
    const unregister = positionOwner.register({
      id: path,
      depth: path.split("/").length,
      distance: () => Math.max(0, -(logicalAnchor()?.offset ?? -Infinity)),
      anchor() {
        return logicalAnchor();
      },
      resolve: (anchor) => {
        const element = elements.get(anchor.key);
        const base = element?.isConnected ? rowStart(anchor.key) : undefined;
        return base === undefined ? undefined : base + anchor.offset;
      },
      retain: (anchor) => pin(anchor.key),
    });
    const releasePosition = positionOwner.subscribe(() => {
      selection();
      sync();
      remember();
    });
    observer = new ResizeObserver((entries) => {
      selection();
      transaction(() => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.virtualKey;
          if (key && elements.get(key) === entry.target) {
            beginMeasurement();
            if (!measuring.has(key)) measuring.set(key, 0);
          }
        }
        sync();
        queueMeasurement();
      });
    });
    observer.observe(root);
    observer.observe(container);
    for (const element of elements.values()) observer.observe(element);
    const moved = () => {
      selection();
      sync();
      remember();
    };
    const retain = (event: Event) => {
      const key = keyFor(event.target);
      if (!key) return;
      contextLeases.set(key, (contextLeases.get(key) ?? 0) + 1);
      setContexts([...contextLeases.keys()]);
      let retained = true;
      (event as CustomEvent<{ release: (() => void)[] }>).detail.release.push(
        () => {
          if (!retained) return;
          retained = false;
          const count = (contextLeases.get(key) ?? 1) - 1;
          if (count) contextLeases.set(key, count);
          else contextLeases.delete(key);
          setContexts([...contextLeases.keys()]);
        },
      );
    };
    const selection = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) {
        if (selectingAll) return;
        setSelected([]);
        setAll(undefined);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!container.isConnected || !range.intersectsNode(container)) {
        setSelected([]);
        return;
      }
      // Native Range is ordered even for reverse/Shift selection. A fully
      // intersecting child window pins its interior, not only endpoint rows.
      const a = keyFor(range.startContainer), b = keyFor(range.endContainer);
      const keys = currentKeys ?? [];
      const first = a ? keys.indexOf(a) : 0,
        last = b ? keys.indexOf(b) : keys.length - 1;
      setSelected(keys.slice(Math.min(first, last), Math.max(first, last) + 1));
    };
    const selectAll = async (event: KeyboardEvent) => {
      if (
        parent || event.key.toLowerCase() !== "a" ||
        !(event.ctrlKey || event.metaKey) ||
        (event.target instanceof HTMLElement &&
          event.target.closest("input,textarea,[contenteditable=true]"))
      ) return;
      event.preventDefault();
      selectingAll = true;
      const acquired = [...props.keys];
      setAll(acquired);
      do {
        await frame();
        if (acquired.some((key) => model.offset(key) === undefined)) {
          selectingAll = false;
          setAll(undefined);
          return;
        }
      } while (!disposed && ![...materializers].every((ready) => ready()));
      if (disposed) return;
      const first = elements.get(acquired[0]),
        last = elements.get(acquired.at(-1)!);
      if (!first?.isConnected || !last?.isConnected) {
        selectingAll = false;
        setAll(undefined);
        return;
      }
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.childNodes.length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      selectingAll = false;
    };
    root.addEventListener("scroll", moved, { passive: true });
    container.addEventListener("otk-context-retain", retain);
    container.addEventListener("keydown", selectAll);
    document.addEventListener("selectionchange", selection);
    focusMoves = new MutationObserver(retainMovedFocus);
    focusMoves.observe(container, { childList: true });
    sync();
    remember();
    setReady(true);
    queueMeasurement();
    return () => {
      remember();
      observer?.disconnect();
      focusMoves?.disconnect();
      focusMoves = undefined;
      focusedControl = undefined;
      unregister();
      releasePosition();
      lease.release();
      positionOwner = undefined;
      root.removeEventListener("scroll", moved);
      container.removeEventListener("otk-context-retain", retain);
      container.removeEventListener("keydown", selectAll);
      document.removeEventListener("selectionchange", selection);
    };
  });
  function Item(input: { key: string }) {
    let element!: HTMLDivElement;
    const native = nativeAttributes(() =>
      props.itemAttributes?.(input.key) ?? {}
    );
    const releaseMeasurement = holdMeasurement(input.key);
    onCleanup(() => {
      releaseMeasurement();
      measuring.delete(input.key);
    });
    function Content() {
      return untrack(() => props.render(input.key));
    }
    onSettled(() => {
      elements.set(input.key, element);
      observer?.observe(element);
      releaseMeasurement();
      positionOwner?.transaction(() => {});
      return () => {
        observer?.unobserve(element);
        elements.delete(input.key);
        measuring.delete(input.key);
      };
    });
    return (
      <div
        ref={[(value) => {
          element = value;
        }, native.ref]}
        data-virtual-key={input.key}
        class="otk-virtual-item"
        role="listitem"
        {...native.attributes}
      >
        <Viewport
          value={{
            element: viewport,
            materialized: () =>
              !!parent?.materialized() || !!all()?.includes(input.key),
            measurements,
            materializers,
            hold: () => holdMeasurement(input.key),
            pin: () => pin(input.key),
            path: `${path}/${encodeURIComponent(input.key)}`,
          }}
        >
          <Content />
        </Viewport>
      </div>
    );
  }
  onCleanup(() => {
    disposed = true;
    if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
    releaseParentMeasurement?.();
    releaseGeometryMeasurement?.();
    measuring.clear();
    materializers.delete(materializedReady);
    releasePins?.();
    elements.clear();
  });
  return (
    <Viewport
      value={{
        element: viewport,
        materialized,
        measurements,
        materializers,
        hold: parent?.hold,
        pin: parent?.pin,
        path,
      }}
    >
      <div
        ref={container}
        class={`otk-virtual-list ${
          borrowed ? "otk-virtual-borrowed" : scrollRegion()
        } ${props.class ?? ""}`}
        role="list"
        aria-label={props.label}
        data-acquired-count={props.keys.length}
        onFocusIn={(event) => acceptFocus(event.target)}
        onFocusOut={() =>
          queueMicrotask(() => {
            if (!container.isConnected) return;
            retainMovedFocus(focusMoves?.takeRecords() ?? []);
            acceptFocus(document.activeElement);
          })}
      >
        <div class="otk-virtual-measure" aria-hidden="true">
          <For each={props.samples ?? []} keyed={(s) => s.role}>
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
    </Viewport>
  );
}
