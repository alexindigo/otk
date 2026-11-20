// SPDX-License-Identifier: LGPL-3.0-only
import "./Tree.css" with { type: "text" };
import { createContext, type Element, For, Show, useContext } from "solid-js";

type Branch = { last: boolean; outgoing?: boolean };
const BranchContext = createContext<Branch | null>(null);
const DirectionContext = createContext(false);

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
    children?: Element;
  },
): Element {
  return (
    <span
      class={["otk-tree-junction", props.class, {
        "is-through": props.through,
        "is-tip": props.tip ?? true,
      }]}
    >
      <span class="otk-tree-upper" aria-hidden="true" />
      <span class="otk-tree-lower" aria-hidden="true" />
      <Show when={props.tip ?? true}>
        <TreeConnector />
      </Show>
      {props.children}
    </span>
  );
}

/** Flat virtual hierarchies borrow the same junction cells without owning rows. */
export function TreeGuide(props: { path: readonly boolean[] }): Element {
  return (
    <span class="otk-tree-guide" aria-hidden="true">
      <For each={props.path}>
        {(continues, index) => (
          <Junction
            through={continues}
            tip={index() === props.path.length - 1}
          />
        )}
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
  onOpen?(open: boolean): void;
  outgoing?: boolean;
  header(connected: boolean): Element;
  body?(): Element;
}): Element {
  const branch = useContext(BranchContext);
  const direction = useContext(DirectionContext);
  const outgoing = () => props.outgoing ?? branch?.outgoing ?? direction;
  const key = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    props.onOpen?.(event.key === "ArrowRight");
  };
  return (
    <section
      class={["otk-tree-node", props.class, {
        "is-connected": !!branch,
        "is-last": branch?.last ?? true,
        "is-outgoing": outgoing(),
        "has-body": !!props.body && (props.bodyVisible ?? props.open ?? true),
      }]}
      data-tree-node=""
    >
      <div class="otk-tree-heading">
        <Show when={branch}>
          <Junction class="otk-tree-incoming" />
        </Show>
        <Junction class="otk-tree-own">
          <Show
            when={props.onOpen &&
              ((props.hasChildren ?? !!props.body) || props.showEmptyToggle)}
          >
            <button
              type="button"
              class="otk-tree-toggle"
              aria-label={props.open ? "Collapse branch" : "Expand branch"}
              aria-description={props.label}
              aria-expanded={props.open ? "true" : "false"}
              onClick={() => props.onOpen?.(!props.open)}
              onKeyDown={key}
            >
              <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <rect x=".5" y=".5" width="9" height="9" />
                <path d="M3 5h4" />
                <Show when={!props.open}>
                  <path d="M5 3v4" />
                </Show>
              </svg>
            </button>
          </Show>
        </Junction>
        <div class="otk-tree-label">
          <BranchContext value={null}>
            <DirectionContext value={outgoing()}>
              {props.header(!!branch)}
            </DirectionContext>
          </BranchContext>
        </div>
      </div>
      <Show when={props.body && (props.bodyVisible ?? props.open ?? true)}>
        <div class="otk-tree-body">
          <Show when={branch}>
            <span class="otk-tree-continuation" aria-hidden="true" />
          </Show>
          <div class="otk-tree-children">
            <BranchContext value={null}>
              <DirectionContext value={outgoing()}>
                {props.body?.()}
              </DirectionContext>
            </BranchContext>
          </div>
        </div>
      </Show>
    </section>
  );
}
