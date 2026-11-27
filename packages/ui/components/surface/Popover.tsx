// SPDX-License-Identifier: LGPL-3.0-only
import "./Popover.css" with { type: "text" };
import {
  createMemo,
  createSignal,
  createUniqueId,
  type Element,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { type ComponentProps, dynamic, Portal } from "@solidjs/web";
import { nativeAttributes } from "../native-attributes.ts";
import { ownedCommand, useCommandPorts } from "../../keyboard/context.tsx";
import Surface from "./Surface.tsx";
import { selection } from "../selection.ts";
import { hoverIntent } from "../hover-intent.ts";
import { focusControl } from "../../keyboard/focus.ts";

export type PopoverOpenReason = "pointer" | "keyboard";
export interface PopoverControl {
  open(anchor?: PointAnchor, reason?: PopoverOpenReason): void;
  close(restore?: false | (() => void), reason?: PopoverOpenReason): void;
  contains(target: Node): boolean;
  /** Notify the retained origin that its captured action was activated. */
  activateOrigin?(): void;
}
export interface PointAnchor {
  x: number;
  y: number;
  width?: number;
  height?: number;
  origin: HTMLElement;
  returnTo?: HTMLElement | null;
  focus?(): void;
}

export const POPOVER_BOUNDS = "otk-popover-bounds";

/** Native top-layer dismissal and anchoring belong here, never to content. */
export default function Popover(props: {
  label: string;
  triggerLabel?: string;
  busy?: boolean;
  description?: string;
  applied?: string;
  triggerColor?: string;
  trigger?: Element;
  /** Caller-owned style on the trigger, without selecting its internal wrapper. */
  triggerClass?: string;
  triggerAttributes?: Pick<
    ComponentProps<"button">,
    "name" | "aria-describedby" | "aria-invalid"
  >;
  title?: string;
  titleAction?: Element;
  size?: "wide" | "content" | "fit";
  place?: "bounds-end";
  density?: "menu";
  class?: string;
  dismissOnAction?: boolean;
  /** Non-modal detail previews, available on hover and keyboard focus. */
  preview?: boolean;
  /** A preview can describe a real navigation link instead of a button. */
  href?: string;
  panelRole?: "tooltip";
  /** Text users copy when the entire presented value is selected. */
  copySource?: string;
  /** An entity trigger can navigate while retaining the shared preview owner. */
  onActivate?(): void;
  /** Click retains a preview until explicit/outside dismissal. */
  pinOnClick?: boolean;
  control?(control: PopoverControl): void;
  onOpen?(reason: PopoverOpenReason): void;
  onClose?(): void;
  children: Element;
}): Element {
  const anchor = `--otk-popover-${
    createUniqueId().replace(/[^a-zA-Z0-9-]/g, "")
  }`;
  const [open, setOpen] = createSignal(false);
  const [point, setPoint] = createSignal<PointAnchor>();
  const [root, setRoot] = createSignal<HTMLElement>();
  const [request, setRequest] = createSignal<
    { host: HTMLElement; origin?: HTMLElement }
  >();
  const host = createMemo(() => request()?.host ?? root());
  let invocation = 0;
  let openedBy: PopoverOpenReason = "keyboard";
  let active = false;
  let pinned = false;
  let panel!: HTMLDivElement, trigger!: HTMLElement;
  let previewFocus: HTMLElement | undefined;
  let restoringFocus = false;
  let hover: ReturnType<typeof hoverIntent> | undefined;
  let releaseHoverPanel: (() => void) | undefined;
  let stopWatching: (() => void) | undefined;
  let releaseOrigin: (() => void)[] = [];
  let activateOrigin: (() => void)[] = [];
  const ports = useCommandPorts(), closeId = `${anchor}.close`;
  const release = () => {
    invocation++;
    hover?.cancel();
    releaseHoverPanel?.();
    releaseHoverPanel = undefined;
    stopWatching?.();
    stopWatching = undefined;
    const notify = active;
    active = false;
    pinned = false;
    setOpen(false);
    setPoint(undefined);
    setRequest(undefined);
    previewFocus = undefined;
    const retained = releaseOrigin;
    releaseOrigin = [];
    activateOrigin = [];
    // Dismissal's synchronous focus return owns the row before its surface pin ends.
    queueMicrotask(() => {
      for (const release of retained) release();
    });
    if (notify) props.onClose?.();
  };
  onCleanup(release);
  const dismiss = (
    restore?: false | (() => void),
    reason = ports.keyboard?.focusOwner.modality() ?? openedBy,
  ) => {
    const placement = point();
    const { focus: returnToInput } = placement ?? {};
    const origin = placement
      ? placement.returnTo
      : props.preview && previewFocus?.isConnected
      ? previewFocus
      : trigger;
    restoringFocus = true;
    try {
      panel?.hidePopover();
      release();
      if (restore !== false) {
        const callback = restore ?? returnToInput;
        if (callback) callback();
        else focusControl(origin, { focusVisible: reason === "keyboard" });
      }
    } finally {
      restoringFocus = false;
    }
  };
  const preview = (reason: PopoverOpenReason) => {
    if (!props.preview || restoringFocus) return;
    if (reason === "keyboard") previewFocus = trigger;
    if (panel.matches(":popover-open")) return;
    if (reason === "pointer") {
      previewFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    }
    show(undefined, reason);
  };
  const show = (at?: PointAnchor, reason: PopoverOpenReason = "keyboard") => {
    hover?.cancel();
    openedBy = reason;
    const origin = at?.origin ?? trigger;
    for (const release of releaseOrigin) release();
    releaseOrigin = [];
    activateOrigin = [];
    origin?.dispatchEvent(
      new CustomEvent("otk-context-retain", {
        bubbles: true,
        detail: { release: releaseOrigin, activate: activateOrigin },
      }),
    );
    setPoint(at);
    const next = {
      host: origin?.closest<HTMLDialogElement>("dialog:modal") ?? root()!,
      origin,
    };
    const current = ++invocation;
    active = true;
    setRequest(next);
    // Resolve the host once per show. Portal owns the move; native showing waits
    // for that render. The panel/children remain stable when the host is stable.
    onSettled(() => {
      if (current !== invocation) return;
      if (!panel.isConnected || panel.parentElement !== next.host) {
        release();
        return;
      }
      panel.showPopover({ source: next.origin });
      releaseHoverPanel?.();
      releaseHoverPanel = hover?.retain(panel);
      stopWatching?.();
      const element = panel;
      const detached = new MutationObserver(() => {
        if (!element.isConnected && element === panel) release();
      });
      detached.observe(document, { childList: true, subtree: true });
      // The optional application dispatcher owns Escape when injected. Isolated
      // consumers use this same Popover close owner, not a Menu key handler.
      const escape = (event: KeyboardEvent) => {
        if (
          event.key !== "Escape" || event.repeat || event.isComposing ||
          event.defaultPrevented || !element.matches(":popover-open")
        ) return;
        event.preventDefault();
        event.stopPropagation();
        dismiss(undefined, "keyboard");
      };
      if (!ports.keyboard) document.addEventListener("keydown", escape, true);
      stopWatching = () => {
        detached.disconnect();
        if (!ports.keyboard) {
          document.removeEventListener("keydown", escape, true);
        }
      };
    });
  };
  onSettled(() => {
    hover = hoverIntent(root()!, {
      open: preview,
      close: () => {
        if (props.preview && !pinned) panel.hidePopover();
      },
    });
    return () => hover?.dispose();
  });
  props.control?.({
    open: show,
    close: dismiss,
    activateOrigin: () => {
      const callbacks = activateOrigin;
      activateOrigin = [];
      for (const activate of callbacks) activate();
    },
    contains: (target) =>
      panel?.matches(":popover-open") && panel.contains(target),
  });
  ownedCommand(ports, {
    id: closeId,
    title: `Close ${props.label}`,
    category: "Controls",
    run: () => dismiss(undefined, "keyboard"),
  });
  onSettled(() =>
    ports.keyboard?.layer(closeId, () => panel.matches(":popover-open"), 31)
  );
  const triggerLabel = () =>
    `${props.triggerLabel ?? props.label}${
      props.applied ? `, ${props.applied}` : ""
    }`;
  const Trigger = dynamic(() => props.href ? "a" : "button");
  let pointerDown: { x: number; y: number } | undefined;
  let pointerMoved = false;
  const triggerNative = nativeAttributes(() => ({
    ...props.triggerAttributes,
    onClick: activate,
    onPointerDown: (event: PointerEvent) => {
      openedBy = "pointer";
      pointerDown = { x: event.clientX, y: event.clientY };
      pointerMoved = false;
    },
    onPointerUp: (event: PointerEvent) => {
      // Click rounds coordinates; compare the two pointer events instead.
      pointerMoved = !!pointerDown &&
        (event.clientX !== pointerDown.x || event.clientY !== pointerDown.y);
    },
    onKeyDown: () => {
      openedBy = "keyboard";
    },
  }));
  function activate(event: MouseEvent) {
    if (props.href) {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        return;
      }
      const selected = document.getSelection();
      if (
        event.detail && pointerMoved && !selected?.isCollapsed &&
        selected?.containsNode(trigger, true)
      ) {
        event.preventDefault();
        return;
      }
    }
    event.preventDefault();
    const reason = event.detail ? "pointer" : "keyboard";
    if (props.onActivate) {
      const action = props.onActivate;
      dismiss(undefined, reason);
      action();
    } else if (props.pinOnClick && !pinned) {
      pinned = true;
      if (!panel.matches(":popover-open")) show(undefined, openedBy);
    } else if (panel.matches(":popover-open")) dismiss(undefined, reason);
    else show(undefined, openedBy);
  }
  return (
    <span
      class={`otk-popover ${props.class ?? ""}`}
      ref={setRoot}
      data-copy-source={props.copySource}
      data-open={String(open())}
    >
      <Show when={props.trigger !== undefined}>
        <Trigger
          type={props.href ? undefined : "button"}
          href={props.href}
          draggable={props.href ? false : undefined}
          {...triggerNative.attributes}
          {...selection({
            kind: "candidate",
            selected: false,
            applied: !!props.applied,
            class: ["otk-popover-trigger", props.triggerClass].filter(Boolean)
              .join(" "),
          })}
          aria-label={triggerLabel()}
          aria-busy={props.busy ? "true" : "false"}
          aria-description={props.description}
          title={props.preview ? undefined : triggerLabel()}
          aria-describedby={props.preview
            ? anchor
            : props.triggerAttributes?.["aria-describedby"]}
          aria-expanded={props.href ? undefined : open() ? "true" : "false"}
          popovertarget={props.href ? undefined : anchor}
          style={{
            "anchor-name": point() ? undefined : anchor,
            "--control-color": props.triggerColor,
          }}
          ref={(el: HTMLElement) => {
            triggerNative.ref(el);
            trigger = el;
          }}
        >
          {props.trigger}
        </Trigger>
      </Show>
      <Show when={root()}>
        <Portal mount={host()!}>
          <Show when={point()}>
            <span
              aria-hidden="true"
              class="otk-popover-anchor"
              style={{
                "anchor-name": anchor,
                left: `${point()!.x}px`,
                top: `${point()!.y}px`,
                width: `${point()!.width ?? 0}px`,
                height: `${point()!.height ?? 0}px`,
              }}
            />
          </Show>
          <div
            class={["otk-popover-panel", {
              "otk-popover-wide": props.size === "wide",
              "otk-popover-content": props.size === "content",
              "otk-popover-fit": props.size === "fit",
              "otk-popover-bounds-end": props.place === "bounds-end",
              "otk-popover-point": !!point() && !point()!.width &&
                !point()!.height,
            }]}
            id={anchor}
            popover="auto"
            role={props.panelRole}
            aria-label={props.title ?? props.label}
            style={{ "position-anchor": anchor }}
            ref={(el) => {
              panel = el;
            }}
            onBeforeToggle={(event) => {
              // Closing is non-cancellable and must not disappear into coalesced
              // toggle tasks. Opening/focus waits until the panel is actually shown.
              if (event.newState === "closed") release();
            }}
            onToggle={() => {
              const visible = panel.matches(":popover-open");
              setOpen(visible);
              if (visible) {
                props.onOpen?.(openedBy);
              }
            }}
            onClick={(event) => {
              const button = (event.target as HTMLElement).closest("button");
              if (props.dismissOnAction && button && !button.disabled) {
                dismiss(undefined, event.detail ? "pointer" : "keyboard");
              }
            }}
          >
            <Surface
              layout="popover"
              density={props.density}
              title={props.title ? <h2>{props.title}</h2> : undefined}
              titleAction={props.titleAction}
            >
              {props.children}
            </Surface>
          </div>
        </Portal>
      </Show>
    </span>
  );
}
