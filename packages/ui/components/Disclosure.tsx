// SPDX-License-Identifier: LGPL-3.0-only
import {
  DISCLOSURE_KINDS,
  type DisclosureContextInput,
  type DisclosureIdentity,
  type DisclosureKind,
  type Disclosures,
  type DisclosureState,
} from "@otk/client";
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  type Element,
  onCleanup,
  Show,
  useContext,
} from "solid-js";
import { discloseInViewport } from "./viewport.ts";
import "./Tree.css" with { type: "text" };
import "./Disclosure.css" with { type: "text" };

// Solid treats an undefined default as no default, so a missing provider throws.
const DisclosuresContext = createContext<Disclosures | null>(null);
const DisclosureFocusContext = createContext<(() => boolean) | null>(null);
export const DisclosureFocusHome = createContext<(() => void) | null>(null);
/** Containers can supply placement for the native trigger. */
export const TreeTriggerContext = createContext<string | null>(null);

export function treeTriggerClass(): string | undefined {
  return useContext(TreeTriggerContext) ?? undefined;
}

/** The shared mount for shell and standalone disclosure owners. */
export function DisclosuresProvider(
  props: { owner: Disclosures; children: Element },
): Element {
  return (
    <DisclosuresContext value={props.owner}>
      {props.children}
    </DisclosuresContext>
  );
}

export function useDisclosures(): Disclosures | undefined {
  return useContext(DisclosuresContext) ?? undefined;
}

function useOwner(): Disclosures {
  const owner = useDisclosures();
  if (!owner) throw new Error("Disclosure requires a DisclosuresContext");
  return owner;
}

/** Read or forward intent without keeping a second copy of the open bit. */
export function useDisclosure(
  kind: DisclosureKind | Accessor<DisclosureKind>,
  identity: DisclosureIdentity | Accessor<DisclosureIdentity>,
  input?: DisclosureContextInput | Accessor<DisclosureContextInput | undefined>,
): DisclosureState {
  const owner = useOwner();
  const target = createMemo(() => ({
    kind: typeof kind === "function" ? kind() : kind,
    identity: typeof identity === "function" ? identity() : identity,
  }));
  const binding = createMemo(() =>
    owner.bind(
      target().kind,
      target().identity,
      typeof input === "function" ? input() : input,
    )
  );
  // Standalone transcript owners can use a non-reactive client state factory.
  const [revision, publish] = createSignal(0);
  createEffect(target, ({ kind, identity }) => {
    onCleanup(owner.subscribe(() => publish((n) => n + 1), kind, identity));
  });
  const current = () => {
    revision();
    return binding();
  };
  return {
    open: () => current().open(),
    chosen: () => current().chosen(),
    pending: () => current().pending(),
    error: () => current().error(),
    failureOrder: () => current().failureOrder(),
    set: (open) => binding().set(open),
    retry: () => binding().retry(),
  };
}

/** Subscribe once when a view derives membership over multiple identities. */
export function useDisclosureOwner() {
  const owner = useOwner();
  const [revision, publish] = createSignal(0);
  onCleanup(owner.subscribe(() => publish((n) => n + 1)));
  return () => {
    revision();
    return owner;
  };
}

// Temporary export for DisclosureToggle until its transcript/sidebar consumers
// migrate. Both render the same artwork during the migration.
export function DisclosureIcon(props: { open?: boolean }): Element {
  return (
    <span class="otk-disclosure-icon" aria-hidden="true">
      <svg viewBox="0 0 9 9" fill="none">
        <rect x=".5" y=".5" width="8" height="8" />
        <path d="M2.5 4.5h4" />
        <Show when={!props.open}>
          <path d="M4.5 2.5v4" />
        </Show>
      </svg>
    </span>
  );
}

export interface DisclosureProps {
  kind: DisclosureKind;
  identity: DisclosureIdentity;
  input?: DisclosureContextInput;
  variant: "label" | "meta" | "compact";
  tone?: "danger";
  label: string;
  accessibleLabel?: string;
  labelContent?: () => Element;
  lead?: () => Element;
  meta?: () => Element;
  hasContent: () => boolean;
  focusHome?: () => void;
  children?: (open: () => boolean) => Element;
  outgoing?: boolean;
  class?: string;
  recordKind?: string;
  /** A membership control can address its container's existing region. */
  controls?: string;
  regionId?: string;
  /** Containers arrange these slots without borrowing disclosure behavior. */
  layout?: (slots: DisclosureSlots) => Element;
  /** The enclosing layout already owns the icon and caption tracks. */
  trackAligned?: boolean;
}

interface DisclosureSlots {
  trigger(): Element;
  region(): Element;
  open(): boolean;
  frame(element: HTMLElement): void;
}

/** One state binding, keyboard contract and region lifetime for every fold. */
export default function Disclosure(props: DisclosureProps): Element {
  const state = useDisclosure(
    () => props.kind,
    () => props.identity,
    () => props.input,
  );
  const visible = () => props.hasContent() && state.open();
  const ancestor = useContext(DisclosureFocusContext);
  const focusHome = useContext(DisclosureFocusHome);
  const id = createUniqueId();
  let frame: HTMLElement | undefined;
  let region: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  const focus = (): boolean => {
    if (!trigger?.isConnected || !trigger.getClientRects().length) {
      return ancestor?.() ?? false;
    }
    trigger.focus({ preventScroll: true });
    return document.activeElement === trigger;
  };
  const label = () => (
    <>
      <span
        class={["otk-disclosure-label otk-control-label", {
          "has-content": !!props.labelContent,
        }]}
        title={props.label}
      >
        {props.labelContent?.() ?? props.label}
      </span>
      {props.meta?.()}
    </>
  );
  const caption = (slot?: string) => (
    <Show when={slot} fallback={<>{props.lead?.()}{label()}</>}>
      <span class="otk-disclosure-lead">{props.lead?.()}</span>
      <span class="otk-disclosure-caption">{label()}</span>
    </Show>
  );
  const change = (value: boolean, event: MouseEvent | KeyboardEvent) => {
    if (value === visible()) return;
    if (!value && region?.contains(document.activeElement)) focus();
    discloseInViewport(
      frame ?? trigger,
      value,
      (next) => void state.set(next),
      event.isTrusted,
      trigger,
    );
  };
  function Body() {
    onCleanup(() => {
      if (region?.contains(document.activeElement)) focus();
    });
    return props.children?.(visible);
  }
  function Trigger() {
    const slot = treeTriggerClass();
    onCleanup(() => {
      if (
        !trigger?.contains(document.activeElement) &&
        !region?.contains(document.activeElement)
      ) return;
      queueMicrotask(() => {
        if (
          !document.activeElement?.isConnected ||
          document.activeElement === document.body
        ) {
          if (!ancestor?.()) (props.focusHome ?? focusHome)?.();
        }
      });
    });
    return (
      <button
        type="button"
        data-record-kind={props.recordKind}
        data-no-reorder={slot ? "" : undefined}
        class={["otk-disclosure-button", props.class, slot, {
          "is-outgoing": !slot && props.outgoing,
          "is-track-aligned": props.trackAligned,
          "is-meta": props.variant === "meta",
          "is-compact": props.variant === "compact",
          "is-danger": props.tone === "danger",
        }]}
        ref={(el) => trigger = el}
        aria-expanded={visible() ? "true" : "false"}
        aria-controls={props.controls ?? props.regionId ?? id}
        aria-label={props.variant === "compact"
          ? props.label
          : props.accessibleLabel}
        title={props.variant === "compact" ? props.label : undefined}
        onClick={(event) => change(!visible(), event)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          change(event.key === "ArrowRight", event);
        }}
      >
        <DisclosureIcon open={visible()} />
        <Show when={props.variant !== "compact"}>{caption(slot)}</Show>
      </button>
    );
  }
  function Leaf() {
    const slot = treeTriggerClass();
    return (
      <span
        class={["otk-disclosure-leaf", props.class, slot, {
          "is-danger": props.tone === "danger",
        }]}
      >
        <span />
        {caption(slot)}
      </span>
    );
  }
  const triggerSlot = () => (
    <Show
      when={props.hasContent()}
      fallback={
        <Show when={DISCLOSURE_KINDS[props.kind].empty === "leaf"}>
          <Leaf />
        </Show>
      }
    >
      <Trigger />
    </Show>
  );
  const regionSlot = () => (
    <div
      class="otk-disclosure-region"
      id={props.regionId ?? id}
      role="group"
      hidden={!visible()}
      ref={(el) => region = el}
    >
      <DisclosureFocusContext value={focus}>
        <Show when={visible()}>
          <Body />
        </Show>
      </DisclosureFocusContext>
    </div>
  );
  const frameSlot = (element: HTMLElement) => frame = element;
  if (props.layout) {
    return props.layout({
      trigger: triggerSlot,
      region: regionSlot,
      open: visible,
      frame: frameSlot,
    });
  }
  if (props.controls) return triggerSlot();
  return (
    <Show
      when={props.hasContent() || DISCLOSURE_KINDS[props.kind].empty === "leaf"}
    >
      <div class="otk-disclosure-frame" ref={frameSlot}>
        {triggerSlot()}
        {regionSlot()}
      </div>
    </Show>
  );
}
