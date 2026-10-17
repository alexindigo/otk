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

/** Native top-layer dismissal and anchoring belong here, never to content. */
export default function Popover(props: {
  label: string;
  trigger: Element;
  title?: string;
  class?: string;
  dismissOnAction?: boolean;
  children: Element;
}): Element {
  const anchor = `--otk-popover-${
    createUniqueId().replace(/[^a-zA-Z0-9-]/g, "")
  }`;
  const [open, setOpen] = createSignal(false);
  let panel!: HTMLDivElement, trigger!: HTMLButtonElement;
  const ports = useCommandPorts(), closeId = `${anchor}.close`;
  const dismiss = () => {
    panel.hidePopover();
    trigger.focus();
  };
  ownedCommand(ports, {
    id: closeId,
    title: `Close ${props.label}`,
    category: "Controls",
    hidden: true,
    run: dismiss,
  });
  onSettled(() =>
    ports.keyboard?.layer(closeId, () => panel.matches(":popover-open"), 30)
  );
  return (
    <span class={`otk-popover ${props.class ?? ""}`} data-open={String(open())}>
      <button
        type="button"
        class="otk-popover-trigger"
        aria-label={props.label}
        title={props.label}
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
        onToggle={() =>
          setOpen(panel.matches(":popover-open"))}
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
