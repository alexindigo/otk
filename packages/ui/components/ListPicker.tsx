// SPDX-License-Identifier: LGPL-3.0-only
import "./ListPicker.css" with { type: "text" };
import {
  createEffect,
  createSignal,
  createUniqueId,
  type Element,
  For,
  Show,
} from "solid-js";
import Popover, { type PopoverControl } from "./surface/Popover.tsx";
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";

export interface PickerItem<T = string> {
  key: string;
  value: T;
  label: string;
  description?: string;
  search?: string;
  color?: string;
  tag?: string;
  action?: { label: string; content: Element; run(): void };
}
export interface PickerGroup<T = string> {
  key: string;
  label?: string;
  items: readonly PickerItem<T>[];
}
export interface ListPickerControl {
  open(): void;
}

/** Shared list interaction; data, persistence and pick consequences are injected. */
export default function ListPicker<T = string>(props: {
  label: string;
  triggerLabel?: string;
  applied?: string;
  triggerColor?: string;
  trigger: Element;
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
    root: HTMLDivElement | undefined,
    search: HTMLInputElement | undefined;
  const buttons = new Map<string, HTMLDivElement>();
  const groups = () =>
    props.groups.map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        `${item.label} ${item.description ?? ""} ${item.search ?? ""}`
          .toLowerCase().includes(query().trim().toLowerCase())
      ),
    })).filter((group) => group.items.length);
  const rows = () => groups().flatMap((group) => group.items);
  const candidate = () => {
    const items = rows();
    return items.find((item) => item.key === highlighted())?.key ??
      items.find((item) => item.key === props.selected)?.key ?? items[0]?.key;
  };
  createEffect(
    () => opened() ? { key: candidate(), groups: groups() } : undefined,
    (current) => {
      if (current?.key !== undefined) {
        buttons.get(current.key)?.scrollIntoView({
          block: "nearest",
        });
      }
    },
  );
  createEffect(opened, (open) => {
    if (open) (props.search ? search : root)?.focus();
  });
  const pick = (key: string) => {
    const item = rows().find((item) => item.key === key);
    if (!item) return;
    props.onPick(item.value);
    popover.close(props.focusAfterPick);
  };
  const move = (key: string) => {
    const items = rows();
    if (!items.length) return;
    const at = items.findIndex((item) => item.key === candidate());
    const next = key === "Home"
      ? 0
      : key === "End"
      ? items.length - 1
      : (at + (key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    setHighlighted(items[next].key);
  };
  return (
    <Popover
      label={props.label}
      triggerLabel={props.triggerLabel}
      applied={props.applied}
      triggerColor={props.triggerColor}
      trigger={props.trigger}
      triggerClass={props.triggerClass}
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
        buttons.clear();
        root = undefined;
        search = undefined;
      }}
    >
      <Show when={opened()}>
        <div
          class="otk-picker-content"
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
              !(event.target as HTMLElement).closest(".otk-picker-action")
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
          <div
            id={id}
            class="otk-picker-groups"
            role="listbox"
            aria-label={props.label}
          >
            <For each={groups()} keyed={(group) => group.key}>
              {(group) => (
                <section role="group" aria-label={group().label}>
                  <Show when={group().label}>
                    <h3>{group().label}</h3>
                  </Show>
                  <For each={group().items} keyed={(item) => item.key}>
                    {(item) => (
                      <div
                        role="option"
                        id={`${id}-${encodeURIComponent(item().key)}`}
                        data-picker-key={item().key}
                        data-otk-selection="vertical"
                        {...selection({
                          kind: "selected",
                          selected: props.selected === item().key,
                          highlighted: candidate() === item().key,
                          class: "otk-picker-row",
                        })}
                        ref={(el) => {
                          buttons.set(item().key, el);
                        }}
                        onPointerMove={() => setHighlighted(item().key)}
                      >
                        <SelectionContent>
                          <button
                            type="button"
                            class="otk-picker-option"
                            onFocus={() => setHighlighted(item().key)}
                            onClick={() => pick(item().key)}
                          >
                            <span
                              class="otk-picker-name"
                              style={{ color: item().color }}
                            >
                              <span>{item().label}</span>
                              <Show when={item().description}>
                                <small>{item().description}</small>
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
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
          <Show when={!props.loading && !props.error && !rows().length}>
            <p class="otk-picker-empty">
              {query() ? "No matches." : "No options available."}
            </p>
          </Show>
        </div>
      </Show>
    </Popover>
  );
}
