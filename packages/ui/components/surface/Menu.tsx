// SPDX-License-Identifier: LGPL-3.0-only
import "./Menu.css" with { type: "text" };
import { type Element, onSettled } from "solid-js";
import Popover, {
  type PopoverControl,
  type PopoverOpenReason,
} from "./Popover.tsx";

export default function Menu(props: {
  label: string;
  trigger?: Element;
  class?: string;
  control?(control: PopoverControl): void;
  dismissOnAction?: boolean;
  onClose?(): void;
  onOpen?(reason: PopoverOpenReason): void;
  status?: Element;
  children: Element;
}): Element {
  let root!: HTMLDivElement, popover!: PopoverControl;
  let query = "", typedAt = 0;
  const items = () =>
    [...root.querySelectorAll<HTMLButtonElement>("button")]
      .filter((button) =>
        !button.disabled && button.closest('[role="menu"]') === root &&
        !!button.getClientRects().length
      );
  const rove = (button: HTMLButtonElement | undefined) => {
    for (const item of items()) {
      item.setAttribute("role", "menuitem");
      item.tabIndex = item === button ? 0 : -1;
    }
    button?.focus();
  };
  return (
    <Popover
      label={props.label}
      trigger={props.trigger}
      size="content"
      class={`otk-menu ${props.class ?? ""}`}
      dismissOnAction={props.dismissOnAction ?? true}
      control={(control) => {
        popover = control;
        props.control?.(control);
      }}
      onOpen={(reason) => {
        props.onOpen?.(reason);
        query = "";
        typedAt = 0;
        onSettled(() => {
          const first = reason === "keyboard" ? items()[0] : undefined;
          rove(first);
          if (!first) root.focus();
        });
      }}
      onClose={props.onClose}
    >
      <div
        class="otk-menu-items"
        role="menu"
        aria-label={props.label}
        tabindex={-1}
        ref={(element) => {
          root = element;
        }}
        onFocusIn={(event) => {
          const target = event.target;
          if (target instanceof HTMLButtonElement) {
            for (const item of items()) {
              item.tabIndex = item === target ? 0 : -1;
            }
          }
        }}
        onKeyDown={(event) => {
          if (
            event.isComposing || event.ctrlKey || event.metaKey || event.altKey
          ) return;
          const rows = items(),
            at = rows.indexOf(document.activeElement as HTMLButtonElement);
          if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            const next = event.key === "Home"
              ? 0
              : event.key === "End"
              ? rows.length - 1
              : at < 0
              ? (event.key === "ArrowUp" ? rows.length - 1 : 0)
              : (at + (event.key === "ArrowUp" ? -1 : 1) + rows.length) %
                rows.length;
            rove(rows[next]);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) rows[at]?.click();
          } else if (event.key === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            popover.close();
          } else if (event.key.length === 1 && event.key !== " ") {
            event.preventDefault();
            event.stopPropagation();
            const now = performance.now(),
              letter = event.key.toLocaleLowerCase();
            query = now - typedAt > 700 ? letter : query + letter;
            typedAt = now;
            const search = [...rows.slice(at + 1), ...rows.slice(0, at + 1)];
            const prefix = [...query].every((char) => char === letter)
              ? letter
              : query;
            rove(
              search.find((row) =>
                row.textContent?.trim().toLocaleLowerCase().startsWith(prefix)
              ) ?? rows[at],
            );
          }
        }}
      >
        {props.children}
      </div>
      {props.status}
    </Popover>
  );
}
