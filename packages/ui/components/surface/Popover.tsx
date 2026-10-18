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

export interface PopoverControl {
  open(): void;
  close(focus?: () => void): void;
}

/** Native top-layer dismissal and anchoring belong here, never to content. */
export default function Popover(props: {
  label: string;
  triggerLabel?: string;
  trigger: Element;
  title?: string;
  class?: string;
  dismissOnAction?: boolean;
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
  const ports = useCommandPorts(), closeId = `${anchor}.close`;
  const dismiss = (focus: () => void = () => trigger.focus()) => {
    panel.hidePopover();
    focus();
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
  return (
    <span class={`otk-popover ${props.class ?? ""}`} data-open={String(open())}>
      <button
        type="button"
        class="otk-popover-trigger"
        aria-label={props.triggerLabel ?? props.label}
        title={props.triggerLabel ?? props.label}
        aria-expanded={open() ? "true" : "false"}
        popovertarget={anchor}
        style={{ "anchor-name": anchor }}
        ref={(el) => {
          trigger = el;
        }}
      >
        {props.trigger}
      </button>
      <div
        class="otk-popover-panel"
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
