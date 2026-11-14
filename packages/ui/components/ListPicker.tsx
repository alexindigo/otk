// SPDX-License-Identifier: LGPL-3.0-only
import "./ListPicker.css" with { type: "text" };
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  type Element,
  Show,
} from "solid-js";
import { isCancellation } from "@otk/protocol";
import VirtualList, { type VirtualListControl } from "./VirtualList.tsx";
import { pickerProjection } from "./picker-projection.ts";
import Popover, { type PopoverControl } from "./surface/Popover.tsx";
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import ControlValue from "./ControlValue.tsx";
import { ChevronDownIcon } from "./ChromeIcons.tsx";

export interface PickerItem<T = string> {
  key: string;
  value: T;
  label: string;
  description?: string;
  search?: string;
  color?: string;
  tag?: string;
  unavailable?: string;
  action?: { label: string; content: Element; run(): void };
}
export interface PickerGroup<T = string> {
  key: string;
  label?: string;
  items: readonly PickerItem<T>[];
}
export interface ListPickerControl {
  open: PopoverControl["open"];
}

/** Shared list interaction; data, persistence and pick consequences are injected. */
export default function ListPicker<T = string>(props: {
  label: string;
  triggerLabel?: string;
  applied?: string;
  triggerColor?: string;
  trigger?: Element;
  triggerClass?: string;
  groups: readonly PickerGroup<T>[];
  selected?: string;
  search?: string;
  status?: Element;
  loading?: boolean;
  error?: string;
  header?: Element;
  class?: string;
  onPick(value: T): void;
  onOpen?(): void;
  focusAfterPick(): void;
  control?(control: ListPickerControl): void;
}): Element {
  const id = createUniqueId();
  const [query, setQuery] = createSignal("");
  const [highlighted, setHighlighted] = createSignal<string>();
  const [opened, setOpened] = createSignal(false);
  let popover!: PopoverControl,
    window: VirtualListControl | undefined,
    root: HTMLDivElement | undefined,
    search: HTMLInputElement | undefined;
  // Catalog projection has no query/candidate dependency. A query scans once;
  // each row then borrows indexed facts rather than rebuilding the population.
  const groups = createMemo(() => props.groups);
  const snapshot = createMemo(() => pickerProjection(groups(), query()));
  const candidate = createMemo(() => {
    const { indices, available } = snapshot();
    const highlightedKey = highlighted(), selectedKey = props.selected;
    return highlightedKey !== undefined && indices.has(highlightedKey)
      ? highlightedKey
      : selectedKey !== undefined && indices.has(selectedKey)
      ? selectedKey
      : available[0];
  });
  const pins = createMemo(() =>
    [...new Set([candidate(), props.selected])].flatMap((key) =>
      key !== undefined && snapshot().items.has(key) ? [`option:${key}`] : []
    )
  );
  createEffect(
    () => opened() ? { key: candidate(), snapshot: snapshot() } : undefined,
    (current) => {
      if (current?.key !== undefined) {
        void window?.reveal(`option:${current.key}`).catch((error) => {
          if (
            !isCancellation(error) && opened() &&
            snapshot() === current.snapshot && candidate() === current.key
          ) throw error;
        });
      }
    },
  );
  createEffect(opened, (open) => {
    if (open) (props.search ? search : root)?.focus();
  });
  const pick = (key: string) => {
    const item = snapshot().items.get(key);
    if (!item || item.unavailable) return;
    props.onPick(item.value);
    popover.close(props.focusAfterPick);
  };
  const move = (key: string) => {
    const { available: items, indices } = snapshot();
    if (!items.length) return;
    const at = indices.get(candidate()!) ?? 0;
    const next = key === "Home"
      ? 0
      : key === "End"
      ? items.length - 1
      : (at + (key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    setHighlighted(items[next]);
  };
  return (
    <Popover
      label={props.label}
      triggerLabel={props.triggerLabel}
      busy={props.loading}
      description={props.loading
        ? `Loading ${props.label.toLowerCase()}…`
        : props.error}
      applied={props.applied}
      triggerColor={props.triggerColor}
      trigger={props.trigger === undefined
        ? undefined
        : (
          <ControlValue accessory={<ChevronDownIcon />}>
            {props.trigger}
          </ControlValue>
        )}
      triggerClass={`otk-control-trigger ${props.triggerClass ?? ""}`}
      class={`otk-list-picker ${props.class ?? ""}`}
      control={(control) => {
        popover = control;
        props.control?.({ open: control.open });
      }}
      onOpen={() => {
        setQuery("");
        setHighlighted(undefined);
        setOpened(true);
        props.onOpen?.();
      }}
      onClose={() => {
        setOpened(false);
        window = undefined;
        root = undefined;
        search = undefined;
      }}
    >
      <Show when={opened()}>
        <div
          class="otk-picker-content"
          aria-busy={props.loading ? "true" : "false"}
          ref={(el) => {
            root = el;
          }}
          tabindex={-1}
          onKeyDown={(event) => {
            if (event.isComposing) return;
            if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              move(event.key);
            } else if (
              event.key === "Enter" &&
              !(event.target as HTMLElement).closest("button, a[href]")
            ) {
              if (event.repeat) return;
              event.preventDefault();
              event.stopPropagation();
              const key = candidate();
              if (key !== undefined) pick(key);
            } else if (
              props.search && event.key.length === 1 && !event.ctrlKey &&
              !event.metaKey && !event.altKey && event.target !== search
            ) {
              search?.focus();
            }
          }}
        >
          {props.header}
          <Show when={props.search}>
            <input
              ref={(el) => {
                search = el;
              }}
              type="search"
              aria-label={props.search}
              placeholder={props.search}
              value={query()}
              aria-controls={id}
              aria-activedescendant={candidate() === undefined
                ? undefined
                : `${id}-${encodeURIComponent(candidate()!)}`}
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
              onInput={(event) => {
                setQuery(event.currentTarget.value);
                setHighlighted(undefined);
              }}
            />
          </Show>
          {props.status}
          <VirtualList
            id={id}
            class="otk-picker-groups"
            listRole="listbox"
            label={props.label}
            keys={snapshot().keys}
            revision={snapshot()}
            pinned={pins()}
            samples={[
              { role: "heading", class: "otk-picker-group-heading" },
              {
                role: "first-heading",
                class: "otk-picker-group-heading is-first",
              },
              {
                role: "option",
                class: "otk-picker-estimate",
              },
              {
                role: "description",
                class: "otk-picker-estimate has-description",
              },
            ]}
            role={(key) => {
              const row = snapshot().rows.get(key);
              return row?.kind === "heading"
                ? row.first ? "first-heading" : "heading"
                : row?.item?.description || row?.item?.unavailable
                ? "description"
                : "option";
            }}
            itemAttributes={(key) => {
              const row = snapshot().rows.get(key);
              return row?.kind === "option"
                ? { role: "group", "aria-label": row.label }
                : { role: "presentation" };
            }}
            control={(control) => {
              window = control;
            }}
            render={(key) => {
              const initial = snapshot().rows.get(key)!;
              const row = () => snapshot().rows.get(key) ?? initial;
              if (initial.kind === "heading") {
                return (
                  <h3
                    class={`otk-control-label otk-picker-group-heading${
                      row().first ? " is-first" : ""
                    }`}
                    title={row().label}
                  >
                    {row().label}
                  </h3>
                );
              }
              const item = () => row().item!;
              return (
                <div
                  role="option"
                  id={`${id}-${encodeURIComponent(item().key)}`}
                  data-picker-key={item().key}
                  aria-disabled={item().unavailable ? "true" : undefined}
                  aria-posinset={row().position}
                  aria-setsize={row().size}
                  data-otk-selection="vertical"
                  {...selection({
                    kind: "selected",
                    selected: props.selected === item().key,
                    highlighted: candidate() === item().key,
                    class: `otk-picker-row${
                      item().unavailable ? " is-unavailable" : ""
                    }`,
                  })}
                  onPointerMove={() => {
                    if (!item().unavailable) setHighlighted(item().key);
                  }}
                >
                  <SelectionContent>
                    <button
                      type="button"
                      class="otk-picker-option"
                      disabled={!!item().unavailable}
                      aria-description={item().unavailable}
                      onFocus={() => setHighlighted(item().key)}
                      onClick={() => pick(item().key)}
                    >
                      <span
                        class="otk-picker-name"
                        style={{ color: item().color }}
                      >
                        <span
                          class="otk-control-label"
                          title={item().label}
                        >
                          {item().label}
                        </span>
                        <Show when={item().description}>
                          <small
                            class="otk-control-label"
                            title={item().description}
                          >
                            {item().description}
                          </small>
                        </Show>
                        <Show when={item().unavailable}>
                          <small
                            class="otk-control-label"
                            title={item().unavailable}
                          >
                            {item().unavailable}
                          </small>
                        </Show>
                      </span>
                      <Show when={item().tag}>
                        <small class="otk-picker-tag">{item().tag}</small>
                      </Show>
                    </button>
                    <Show when={item().action}>
                      {(action) => (
                        <button
                          type="button"
                          class="otk-picker-action otk-icon-button"
                          disabled={!!item().unavailable}
                          aria-label={action().label}
                          title={action().label}
                          onClick={() => action().run()}
                          onFocus={() => setHighlighted(item().key)}
                        >
                          {action().content}
                        </button>
                      )}
                    </Show>
                  </SelectionContent>
                </div>
              );
            }}
          />
          <Show when={!props.loading && !props.error && !snapshot().items.size}>
            <p class="otk-picker-empty">
              {query() ? "No matches." : "No options available."}
            </p>
          </Show>
        </div>
      </Show>
    </Popover>
  );
}
