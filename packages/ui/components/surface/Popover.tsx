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
import { Portal } from "@solidjs/web";
import { ownedCommand, useCommandPorts } from "../../keyboard/context.tsx";
import Surface from "./Surface.tsx";
import { selection } from "../selection.ts";
import { hoverIntent } from "../hover-intent.ts";

export type PopoverOpenReason = "pointer" | "keyboard";
export interface PopoverControl {
  open(anchor?: PointAnchor, reason?: PopoverOpenReason): void;
  close(focus?: () => void): void;
  contains(target: Node): boolean;
}
export interface PointAnchor {
  x: number;
  y: number;
  width?: number;
  height?: number;
  origin: HTMLElement;
  focus(): void;
}

/** Native top-layer dismissal and anchoring belong here, never to content. */
export default function Popover(props: {
  label: string;
  triggerLabel?: string;
  applied?: string;
  triggerColor?: string;
  trigger?: Element;
  /** Caller-owned style on the trigger, without selecting its internal wrapper. */
  triggerClass?: string;
  title?: string;
  size?: "wide" | "content";
  class?: string;
  dismissOnAction?: boolean;
  /** Non-modal detail previews, available on hover and keyboard focus. */
  preview?: boolean;
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
  let panel!: HTMLDivElement, trigger!: HTMLButtonElement;
  let previewFocus: HTMLElement | undefined;
  let restoringFocus = false;
  let hover: ReturnType<typeof hoverIntent> | undefined;
  let releaseHoverPanel: (() => void) | undefined;
  let stopWatching: (() => void) | undefined;
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
    setOpen(false);
    setPoint(undefined);
    setRequest(undefined);
    previewFocus = undefined;
    if (notify) props.onClose?.();
  };
  onCleanup(release);
  const dismiss = (focus?: () => void) => {
    const origin = props.preview && previewFocus?.isConnected
      ? previewFocus
      : trigger;
    const restore = focus ?? point()?.focus ?? (() => origin?.focus());
    restoringFocus = true;
    try {
      panel?.hidePopover();
      release();
      restore();
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
        dismiss();
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
        if (props.preview) panel.hidePopover();
      },
    });
    return () => hover?.dispose();
  });
  props.control?.({
    open: show,
    close: dismiss,
    contains: (target) =>
      panel?.matches(":popover-open") && panel.contains(target),
  });
  ownedCommand(ports, {
    id: closeId,
    title: `Close ${props.label}`,
    category: "Controls",
    hidden: true,
    run: () => dismiss(),
  });
  onSettled(() =>
    ports.keyboard?.layer(closeId, () => panel.matches(":popover-open"), 31)
  );
  const triggerLabel = () =>
    `${props.triggerLabel ?? props.label}${
      props.applied ? ` (${props.applied})` : ""
    }`;
  return (
    <span
      class={`otk-popover ${props.class ?? ""}`}
      ref={setRoot}
      data-open={String(open())}
    >
      <Show when={props.trigger !== undefined}>
        <button
          type="button"
          {...selection({
            kind: "candidate",
            selected: false,
            applied: !!props.applied,
            class: ["otk-popover-trigger", props.triggerClass].filter(Boolean)
              .join(" "),
          })}
          aria-label={triggerLabel()}
          title={props.preview ? undefined : triggerLabel()}
          aria-describedby={props.preview ? anchor : undefined}
          aria-expanded={open() ? "true" : "false"}
          popovertarget={anchor}
          onClick={(event) => {
            event.preventDefault();
            if (panel.matches(":popover-open")) dismiss();
            else show(undefined, openedBy);
          }}
          onPointerDown={() => {
            openedBy = "pointer";
          }}
          onKeyDown={() => {
            openedBy = "keyboard";
          }}
          style={{
            "anchor-name": point() ? undefined : anchor,
            "--control-color": props.triggerColor,
          }}
          ref={(el) => {
            trigger = el;
          }}
        >
          {props.trigger}
        </button>
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
            }]}
            id={anchor}
            popover="auto"
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
                dismiss();
              }
            }}
          >
            <Surface title={props.title ? <h2>{props.title}</h2> : undefined}>
              {props.children}
            </Surface>
          </div>
        </Portal>
      </Show>
    </span>
  );
}
