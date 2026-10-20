// SPDX-License-Identifier: LGPL-3.0-only
import "./Popover.css" with { type: "text" };
import {
  createSignal,
  createUniqueId,
  type Element,
  onSettled,
} from "solid-js";
import { ownedCommand, useCommandPorts } from "../../keyboard/context.tsx";
import Surface from "./Surface.tsx";
import { selection } from "../selection.ts";

export interface PopoverControl {
  open(): void;
  close(focus?: () => void): void;
}

/** Native top-layer dismissal and anchoring belong here, never to content. */
export default function Popover(props: {
  label: string;
  triggerLabel?: string;
  applied?: string;
  triggerColor?: string;
  trigger: Element;
  title?: string;
  size?: "wide";
  class?: string;
  dismissOnAction?: boolean;
  /** Non-modal detail previews, available on hover and keyboard focus. */
  preview?: boolean;
  control?(control: PopoverControl): void;
  onOpen?(): void;
  onClose?(): void;
  children: Element;
}): Element {
  const anchor = `--otk-popover-${
    createUniqueId().replace(/[^a-zA-Z0-9-]/g, "")
  }`;
  const [open, setOpen] = createSignal(false);
  let panel!: HTMLDivElement, trigger!: HTMLButtonElement;
  let previewFocus: HTMLElement | undefined;
  let restoringFocus = false;
  const ports = useCommandPorts(), closeId = `${anchor}.close`;
  const dismiss = (focus: () => void = () => {
    if (props.preview && previewFocus?.isConnected) previewFocus.focus();
    else trigger.focus();
  }) => {
    restoringFocus = true;
    try {
      panel.hidePopover();
      focus();
    } finally {
      restoringFocus = false;
    }
  };
  const preview = (focused = false) => {
    if (!props.preview || restoringFocus) return;
    if (focused) previewFocus = trigger;
    else if (!panel.matches(":popover-open")) {
      previewFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    }
    panel.showPopover();
  };
  props.control?.({ open: () => panel.showPopover(), close: dismiss });
  ownedCommand(ports, {
    id: closeId,
    title: `Close ${props.label}`,
    category: "Controls",
    hidden: true,
    run: () => dismiss(),
  });
  onSettled(() =>
    ports.keyboard?.layer(closeId, () => panel.matches(":popover-open"), 30)
  );
  const triggerLabel = () =>
    `${props.triggerLabel ?? props.label}${
      props.applied ? ` (${props.applied})` : ""
    }`;
  return (
    <span
      class={`otk-popover ${props.class ?? ""}`}
      data-open={String(open())}
      onMouseEnter={() => preview()}
      onMouseLeave={(event) => {
        if (
          props.preview && !event.currentTarget.contains(document.activeElement)
        ) panel.hidePopover();
      }}
      onFocusIn={(event) => preview(event.target === trigger)}
      onFocusOut={(event) => {
        if (
          props.preview &&
          !event.currentTarget.contains(event.relatedTarget as Node | null) &&
          !event.currentTarget.matches(":hover")
        ) panel.hidePopover();
      }}
    >
      <button
        type="button"
        {...selection({
          kind: "candidate",
          selected: false,
          applied: !!props.applied,
          class: "otk-popover-trigger",
        })}
        aria-label={triggerLabel()}
        title={props.preview ? undefined : triggerLabel()}
        aria-describedby={props.preview ? anchor : undefined}
        aria-expanded={open() ? "true" : "false"}
        popovertarget={anchor}
        style={{ "anchor-name": anchor, "--control-color": props.triggerColor }}
        ref={(el) => {
          trigger = el;
        }}
      >
        {props.trigger}
      </button>
      <div
        class={["otk-popover-panel", {
          "otk-popover-wide": props.size === "wide",
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
          if (event.newState === "closed") {
            props.onClose?.();
          }
        }}
        onToggle={() => {
          const visible = panel.matches(":popover-open");
          setOpen(visible);
          if (visible) {
            props.onOpen?.();
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
    </span>
  );
}
