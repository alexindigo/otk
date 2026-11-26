// SPDX-License-Identifier: LGPL-3.0-only
import "./Tree.css" with { type: "text" };
import {
  createContext,
  createUniqueId,
  type Element,
  For,
  Show,
  useContext,
} from "solid-js";
import ContentSlot from "./ContentSlot.tsx";
import DisclosureToggle, { DisclosureLabel } from "./DisclosureToggle.tsx";

type Branch = { last: boolean; outgoing?: boolean };
const BranchContext = createContext<Branch | null>(null);
const DirectionContext = createContext(false);
const IconStemContext = createContext<() => boolean>(() => false);

/** A header supplies its kind artwork; the tree owns its slot and child stem. */
export function TreeIcon(
  props: { children: Element; class?: string },
): Element {
  const stem = useContext(IconStemContext);
  const outgoing = useContext(DirectionContext);
  return (
    <span
      class={["otk-tree-icon", props.class, {
        "has-stem": stem(),
        "is-outgoing": outgoing,
      }]}
    >
      <span class="otk-tree-icon-stem" aria-hidden="true" />
      <span class="otk-tree-icon-art">
        {props.children}
      </span>
    </span>
  );
}

/** Headers with a leading accessory slot borrow the same connector paint. */
export function TreeConnector(props: { class?: string }): Element {
  return (
    <span
      class={["otk-tree-connector", props.class]}
      aria-hidden="true"
    />
  );
}

/** Shared rail cell for nested content and flattened virtual paths alike. */
function Junction(
  props: {
    class?: string;
    through?: boolean;
    tip?: boolean;
    toggle?: boolean;
    children?: Element;
  },
): Element {
  return (
    <span
      class={["otk-tree-junction", props.class, {
        "is-through": props.through,
        "is-tip": props.tip ?? true,
        "has-toggle": props.toggle,
      }]}
    >
      <span class="otk-tree-first-line">
        <span class="otk-tree-upper" aria-hidden="true" />
        <span class="otk-tree-lower" aria-hidden="true" />
        <Show when={props.tip ?? true}>
          <TreeConnector />
        </Show>
        {props.children}
      </span>
      <span class="otk-tree-extension" aria-hidden="true" />
    </span>
  );
}

function TreeRails(props: { path: readonly boolean[] }): Element {
  return (
    <span
      class="otk-tree-rails"
      aria-hidden="true"
    >
      <For each={props.path}>
        {(continues) => <Junction through={continues} tip={false} />}
      </For>
    </span>
  );
}

/** Supplies topology, never disclosure state. Safe across virtual row mounts. */
export function TreeItem(
  props: Branch & { children: Element; connected?: boolean },
): Element {
  const parent = useContext(BranchContext);
  const direction = useContext(DirectionContext);
  const value = {
    get last() {
      return props.last;
    },
    get outgoing() {
      return props.outgoing ?? parent?.outgoing ?? direction;
    },
  };
  return (
    <BranchContext value={props.connected === false ? parent : value}>
      {props.children}
    </BranchContext>
  );
}

/** One in-flow grid owns the junction, child axis and ancestor continuation.
 * Open state and all actions are borrowed from the caller's existing owner. */
export function TreeNode(props: {
  label?: string;
  class?: string;
  open?: boolean;
  hasChildren?: boolean;
  showEmptyToggle?: boolean;
  bodyVisible?: boolean;
  onOpen?(open: boolean, event: MouseEvent | KeyboardEvent): void;
  /** The junction labels the header's sole button, rather than adding another. */
  toggleHeader?: boolean;
  outgoing?: boolean;
  compact?: boolean;
  selected?: boolean;
  /** Virtual row topology: ancestor continuation flags, then this row's flag.
   * A root has an empty path. A flat row never renders a nested body. */
  path?: readonly boolean[];
  header(connected: boolean, toggleID: string): Element;
  feedback?(): Element;
  body?(): Element;
}): Element {
  const branch = useContext(BranchContext);
  const headerID = createUniqueId();
  const toggleID = headerID + "-toggle";
  const direction = useContext(DirectionContext);
  const flat = () => props.path !== undefined;
  const connected = () => flat() ? !!props.path?.length : !!branch;
  const last = () => flat() ? !props.path?.at(-1) : branch?.last ?? true;
  const outgoing = () =>
    !flat() && (props.outgoing ?? branch?.outgoing ?? direction);
  const visible = () =>
    !flat() && !!props.body && (props.bodyVisible ?? props.open ?? true);
  const stem = () =>
    flat() ? props.open !== false && !!props.hasChildren : visible();
  return (
    <section
      class={["otk-tree-node", props.class, {
        "is-flat": flat(),
        "is-connected": connected(),
        "is-last": last(),
        "is-outgoing": outgoing(),
        "has-body": visible(),
        "has-header-toggle": props.toggleHeader,
        "is-compact": props.compact,
        "has-selection-slot": props.selected !== undefined,
        "has-selection": props.selected,
      }]}
      data-tree-node=""
    >
      <div
        class="otk-tree-heading"
        onKeyDown={(event) => {
          if (
            (event.target as HTMLElement).id !== toggleID ||
            event.key !== "ArrowLeft" && event.key !== "ArrowRight"
          ) return;
          event.preventDefault();
          event.stopPropagation();
          props.onOpen?.(event.key === "ArrowRight", event);
        }}
      >
        <Show when={props.path}>
          {(path) => <TreeRails path={path().slice(0, -1)} />}
        </Show>
        <Show when={props.selected !== undefined}>
          <span class="otk-tree-selection" aria-hidden="true">
            <span class="otk-tree-selection-mark" />
          </span>
        </Show>
        <Junction
          class={connected()
            ? "otk-tree-own otk-tree-incoming"
            : "otk-tree-own"}
          toggle={!!props.onOpen &&
            ((props.hasChildren ?? !!props.body) || props.showEmptyToggle)}
        >
          <Show
            when={props.onOpen &&
              ((props.hasChildren ?? !!props.body) || props.showEmptyToggle)}
          >
            <span class="otk-tree-toggle-slot">
              <Show
                when={props.toggleHeader}
                fallback={
                  <DisclosureToggle
                    class="otk-tree-control"
                    variant="tree"
                    label={props.label ??
                      (props.open ? "Collapse branch" : "Expand branch")}
                    open={props.open}
                    onOpen={(open, event) => props.onOpen?.(open, event)}
                  />
                }
              >
                <DisclosureLabel
                  for={toggleID}
                  label={props.label}
                  open={props.open}
                />
              </Show>
            </span>
          </Show>
        </Junction>
        <div class="otk-tree-label" id={headerID}>
          <BranchContext value={null}>
            <DirectionContext value={outgoing()}>
              <IconStemContext value={stem}>
                <ContentSlot
                  content={() => props.header(connected(), toggleID)}
                />
              </IconStemContext>
            </DirectionContext>
          </BranchContext>
        </div>
      </div>
      <Show when={props.feedback}>
        <div class="otk-tree-feedback">
          <div class="otk-tree-feedback-content">
            <BranchContext value={null}>
              <DirectionContext value={false}>
                <ContentSlot content={() => props.feedback?.()} />
              </DirectionContext>
            </BranchContext>
          </div>
        </div>
      </Show>
      <Show when={visible()}>
        <div class="otk-tree-body">
          <span class="otk-tree-continuation" aria-hidden="true" />
          <div class="otk-tree-children">
            <BranchContext value={null}>
              <DirectionContext value={outgoing()}>
                <ContentSlot content={() => props.body?.()} />
              </DirectionContext>
            </BranchContext>
          </div>
        </div>
      </Show>
    </section>
  );
}
