// SPDX-License-Identifier: LGPL-3.0-only
import "./Tree.css" with { type: "text" };
import { nativeAttributes } from "./native-attributes.ts";
import { laneStates, type TreeLaneStates } from "@otk/client";
import {
  createContext,
  createMemo,
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
  props: { children: Element; class?: string; extend?: boolean },
): Element {
  const stem = useContext(IconStemContext);
  const outgoing = useContext(DirectionContext);
  return (
    <span
      class={["otk-tree-icon", props.class, {
        "has-stem": stem(),
        "is-outgoing": outgoing,
        "has-extension": props.extend,
      }]}
    >
      <span class="otk-tree-icon-line">
        <span class="otk-tree-icon-stem" aria-hidden="true" />
        <span class="otk-tree-icon-art">{props.children}</span>
      </span>
      <Show when={props.extend}>
        <span class="otk-tree-icon-extension" aria-hidden="true" />
      </Show>
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

/** Junction for the legacy nested tree; flat rows use TreeLanes. */
function Junction(
  props: { class: string; toggle: boolean; children: Element },
): Element {
  return (
    <span
      class={["otk-tree-junction", props.class, { "has-toggle": props.toggle }]}
    >
      <span class="otk-tree-first-line">
        <span class="otk-tree-upper" aria-hidden="true" />
        <span class="otk-tree-lower" aria-hidden="true" />
        <TreeConnector />
        {props.children}
      </span>
      <span class="otk-tree-extension" aria-hidden="true" />
    </span>
  );
}

type Frame = (
  slots: { class: string; toggleID: string; children: Element },
) => Element;

function TreeLanes(props: {
  states: TreeLaneStates;
  trigger: boolean;
  toggleID: string;
  node?: () => Element;
  frame?: Frame;
  children: Element;
}): Element {
  const slots = () => (
    <>
      <span
        class={`otk-tree-node-lane is-${props.states.node}`}
        data-lane-segment=""
      >
        <span class="otk-tree-node-line">
          <Show when={props.node}>
            <span class="otk-tree-slot otk-tree-node-slot">
              <ContentSlot content={props.node} />
            </span>
          </Show>
          <span
            class="otk-tree-stem-paint"
            data-lane-paint=""
            aria-hidden="true"
          />
        </span>
        <span
          class="otk-tree-lane-extension"
          data-lane-paint=""
          aria-hidden="true"
        />
      </span>
      {props.children}
    </>
  );
  return (
    <>
      <span class="otk-tree-lanes" aria-hidden="true">
        <For each={props.states.ancestors}>
          {(state) => (
            <span class={`otk-tree-lane is-${state}`} data-lane-segment="">
              <span class="otk-tree-through-paint" data-lane-paint="" />
            </span>
          )}
        </For>
      </span>
      <span
        class={[
          "otk-tree-junction",
          `is-${props.states.junction}`,
          { "has-trigger": props.trigger },
        ]}
        data-lane-segment=""
        aria-hidden="true"
      >
        <span class="otk-tree-junction-line">
          <span class="otk-tree-upper" data-lane-paint="" />
          <span class="otk-tree-lower" data-lane-paint="" />
          <TreeConnector />
        </span>
        <span class="otk-tree-lane-extension" data-lane-paint="" />
      </span>
      <ContentSlot
        content={() =>
          props.frame
            ? props.frame({
              class: "otk-tree-frame",
              toggleID: props.toggleID,
              children: slots(),
            })
            : <div class="otk-tree-frame">{slots()}</div>}
      />
    </>
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
  heading?:
    & import("@solidjs/web").ComponentProps<"div">
    & Partial<Record<`data-${string}`, string>>;
  /** Virtual row topology: ancestor continuation flags, then this row's flag.
   * A root has an empty path. A flat row never renders a nested body. */
  path?: readonly boolean[];
  /** Flat row art and optional surface. Tree supplies the surface's subgrid. */
  node?(): Element;
  frame?: Frame;
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
  const outgoing = () => props.outgoing ?? branch?.outgoing ?? direction;
  const visible = () =>
    !flat() && !!props.body && (props.bodyVisible ?? props.open ?? true);
  const stem = () =>
    flat() ? props.open !== false && !!props.hasChildren : visible();
  const lanes = createMemo(() =>
    laneStates(props.path ?? [], {
      connected: connected(),
      art: !!props.node,
      stem: stem(),
    })
  );
  const hasToggle = () =>
    !!props.onOpen &&
    ((props.hasChildren ?? !!props.body) || !!props.showEmptyToggle);
  const trigger = () => (
    <Show when={hasToggle()}>
      <span
        class={flat()
          ? "otk-tree-slot otk-tree-trigger-slot"
          : "otk-tree-toggle-slot"}
        data-no-reorder=""
      >
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
  );
  const selection = () => (
    <Show when={props.selected !== undefined}>
      <span class="otk-tree-selection" aria-hidden="true">
        <span class="otk-tree-selection-mark" />
      </span>
    </Show>
  );
  const label = () => (
    <span
      class={flat() ? "otk-tree-slot otk-tree-label" : "otk-tree-label"}
      id={headerID}
    >
      <BranchContext value={null}>
        <DirectionContext value={outgoing()}>
          <IconStemContext value={stem}>
            <ContentSlot content={() => props.header(connected(), toggleID)} />
          </IconStemContext>
        </DirectionContext>
      </BranchContext>
    </span>
  );
  const heading = nativeAttributes(() => props.heading ?? {}, [
    "class",
    "onKeyDown",
  ]);
  return (
    <section
      class={["otk-tree-node", props.class, {
        "is-flat": flat(),
        "is-connected": connected(),
        "is-last": !flat() && (branch?.last ?? true),
        "is-outgoing": outgoing(),
        "has-body": visible(),
        "has-header-toggle": props.toggleHeader,
        "is-compact": props.compact,
        "has-selection-slot": props.selected !== undefined,
        "has-selection": props.selected,
      }]}
      data-tree-node=""
      data-depth={props.path?.length}
    >
      <div
        {...heading.attributes}
        ref={(element) => {
          heading.ref(element);
          if (typeof props.heading?.ref === "function") {
            props.heading.ref(
              element,
            );
          }
        }}
        class={["otk-tree-heading", {
          "otk-tree-row": flat(),
          "has-node": !!props.node,
          "is-outgoing": flat() && outgoing(),
          "is-compact": flat() && props.compact,
        }]}
        data-tree-depth={props.path?.length}
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
        <Show
          when={flat()}
          fallback={
            <>
              {selection()}
              <Junction
                class={connected()
                  ? "otk-tree-own otk-tree-incoming"
                  : "otk-tree-own"}
                toggle={hasToggle()}
              >
                {trigger()}
              </Junction>
              {label()}
            </>
          }
        >
          {selection()}
          {trigger()}
          <TreeLanes
            states={lanes()}
            trigger={hasToggle()}
            node={props.node}
            frame={props.frame}
            toggleID={toggleID}
          >
            {label()}
            <Show when={props.feedback}>
              <div class="otk-tree-slot otk-tree-feedback-slot">
                <ContentSlot content={props.feedback} />
              </div>
            </Show>
          </TreeLanes>
        </Show>
      </div>
      <Show when={!flat() && props.feedback}>
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
