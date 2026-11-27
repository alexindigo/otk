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
import { TreeTriggerContext } from "./Disclosure.tsx";

export { treeTriggerClass } from "./Disclosure.tsx";

type LaneTopology = { path: readonly boolean[]; outgoing: boolean };
const TreeLanesContext = createContext<LaneTopology | null>(null);
type Trigger = {
  variant: "cell" | "span";
  element: () => Element;
  /** A static label can borrow the same tracks without cutting the rail. */
  hasBox?: () => boolean;
};

type Frame = (
  slots: { class: string; toggleID: string; children: Element },
) => Element;

function TreeLanes(props: {
  states: TreeLaneStates;
  trigger: boolean;
  gap?: boolean;
  toggleID?: string;
  node?: () => Element;
  frame?: Frame;
  children?: Element;
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
          `is-${
            props.gap
              ? props.states.junction === "tee" ? "through" : "none"
              : props.states.junction
          }`,
          { "has-trigger": props.trigger },
        ]}
        data-lane-segment=""
        aria-hidden="true"
      >
        <span class="otk-tree-junction-line">
          <span class="otk-tree-upper" data-lane-paint="" />
          <span class="otk-tree-lower" data-lane-paint="" />
          <span class="otk-tree-connector" />
        </span>
        <span class="otk-tree-lane-extension" data-lane-paint="" />
        <span class="otk-tree-through-paint" data-lane-paint="" />
      </span>
      <ContentSlot
        content={() =>
          props.frame
            ? props.frame({
              class: "otk-tree-frame",
              toggleID: props.toggleID!,
              children: slots(),
            })
            : <div class="otk-tree-frame">{slots()}</div>}
      />
    </>
  );
}

/** Supplies topology, never disclosure state. Safe across virtual row mounts. */
export function TreeItem(props: {
  last: boolean;
  outgoing?: boolean;
  connected?: boolean;
  children: Element;
}): Element {
  const parent = useContext(TreeLanesContext);
  const outgoing = () => props.outgoing ?? parent?.outgoing ?? false;
  const value = {
    get outgoing() {
      return outgoing();
    },
    get path() {
      return !parent || props.connected === false ||
          parent.outgoing !== outgoing()
        ? []
        : [...parent.path, !props.last];
    },
  };
  return <TreeLanesContext value={value}>{props.children}</TreeLanesContext>;
}

/** One in-flow grid owns the junction, child axis and ancestor continuation.
 * Open state and all actions are borrowed from the caller's existing owner. */
export function TreeNode(props: {
  label?: string;
  class?: string;
  ref?(element: HTMLElement): void;
  open?: boolean;
  hasChildren?: boolean;
  showEmptyToggle?: boolean;
  bodyVisible?: boolean;
  onOpen?(open: boolean, event: MouseEvent | KeyboardEvent): void;
  /** The junction labels the header's sole button, rather than adding another. */
  toggleHeader?: boolean;
  trigger?: Trigger;
  outgoing?: boolean;
  compact?: boolean;
  selected?: boolean;
  heading?:
    & import("@solidjs/web").ComponentProps<"div">
    & Partial<Record<`data-${string}`, string>>;
  /** Virtual row topology: ancestor continuation flags, then this row's flag.
   * A root has an empty path. A flat row never renders a nested body. */
  path?: readonly boolean[];
  /** Reserve the artwork lane even when aligning a content-only row. */
  alignLabel?: boolean;
  /** Semantic artwork and optional surface. Tree owns their tracks. */
  node?(): Element;
  frame?: Frame;
  header?(connected: boolean, toggleID: string): Element;
  trail?(): Element;
  feedback?(): Element;
  /** Feedback with its own leading control may borrow the artwork track. */
  feedbackGutter?: boolean;
  regionRole?: "group";
  body?(): Element;
  /** A stateful child can keep its own ARIA region mounted while closed. */
  region?(): Element;
}): Element {
  const topology = useContext(TreeLanesContext);
  const headerID = createUniqueId();
  const toggleID = headerID + "-toggle";
  const outgoing = () => props.outgoing ?? topology?.outgoing ?? false;
  const path = () =>
    props.path ??
      (topology?.outgoing === outgoing() ? topology.path : []);
  const connected = () => path().length > 0;
  const visible = () =>
    props.path === undefined && !!(props.body || props.region) &&
    (props.bodyVisible ?? props.open ?? true);
  const region = {
    get path() {
      return path();
    },
    get outgoing() {
      return outgoing();
    },
  };
  const spanning = () => props.trigger?.variant === "span";
  const lanes = createMemo(() =>
    laneStates(path(), {
      connected: connected(),
      art: !!props.node || spanning(),
      stem: props.path === undefined
        ? visible()
        : props.open !== false && !!props.hasChildren,
    })
  );
  const hasToggle = () =>
    !!props.onOpen &&
    ((props.hasChildren ?? !!props.body) || !!props.showEmptyToggle);
  const builtInTrigger = () => (
    <Show when={hasToggle()}>
      <span
        class="otk-tree-slot otk-tree-trigger-slot"
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
  const trigger = () => (
    <Show when={props.trigger} fallback={builtInTrigger()}>
      {(trigger) => (
        <Show
          when={spanning()}
          fallback={
            <span
              class="otk-tree-slot otk-tree-trigger-slot"
              data-no-reorder=""
            >
              <ContentSlot content={trigger().element} />
            </span>
          }
        >
          <TreeTriggerContext value="otk-tree-trigger">
            <ContentSlot content={trigger().element} />
          </TreeTriggerContext>
        </Show>
      )}
    </Show>
  );
  const label = () => (
    <Show when={!spanning()}>
      <div class="otk-tree-slot otk-tree-label" id={headerID}>
        <TreeLanesContext value={null}>
          <ContentSlot content={() => props.header?.(connected(), toggleID)} />
        </TreeLanesContext>
      </div>
    </Show>
  );
  const heading = nativeAttributes(() => props.heading ?? {}, [
    "class",
    "onKeyDown",
  ]);
  return (
    <section
      ref={(element) => props.ref?.(element)}
      class={["otk-tree-node", props.class, {
        "is-flat": props.path !== undefined,
        "is-connected": connected(),
        "is-last": !path().at(-1),
        "is-outgoing": outgoing(),
        "has-body": visible(),
        "has-header-toggle": props.toggleHeader,
        "is-compact": props.compact,
        "has-selection-slot": props.selected !== undefined,
        "has-selection": props.selected,
      }]}
      data-tree-node=""
      data-depth={path().length}
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
        class={["otk-tree-heading otk-tree-row", props.heading?.class, {
          "has-node": !!props.node || spanning(),
          "is-outgoing": outgoing(),
          "is-compact": props.compact,
          "align-label": props.alignLabel,
          "has-span-trigger": spanning(),
          "has-feedback-gutter": props.feedbackGutter,
        }]}
        data-tree-depth={path().length}
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
        {selection()}
        {trigger()}
        <TreeLanes
          states={lanes()}
          trigger={props.trigger
            ? (props.trigger.hasBox?.() ?? true)
            : hasToggle()}
          node={props.node}
          frame={props.frame}
          toggleID={toggleID}
        >
          {label()}
          <Show when={props.trail}>
            <div class="otk-tree-slot otk-tree-trail-slot">
              <ContentSlot content={props.trail} />
            </div>
          </Show>
          <Show when={props.feedback}>
            <div class="otk-tree-slot otk-tree-feedback-slot">
              <ContentSlot content={props.feedback} />
            </div>
          </Show>
        </TreeLanes>
      </div>
      <Show when={props.path === undefined && (props.region || visible())}>
        <div class="otk-tree-region" role={props.regionRole}>
          <TreeLanesContext value={region}>
            <ContentSlot content={props.region ?? props.body} />
          </TreeLanesContext>
        </div>
      </Show>
      <Show when={props.path === undefined}>
        <div
          class={["otk-tree-row is-gap", { "is-outgoing": outgoing() }]}
          data-tree-depth={path().length}
          aria-hidden="true"
        >
          <TreeLanes
            states={{ ...lanes(), node: "empty" }}
            trigger={false}
            gap
          />
        </div>
      </Show>
    </section>
  );
}
