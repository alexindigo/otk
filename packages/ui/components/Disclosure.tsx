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
  createContext,
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

const DisclosuresContext = createContext<Disclosures | undefined>(undefined);
const DisclosureFocusContext = createContext<(() => boolean) | null>(null);

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
  return useContext(DisclosuresContext);
}

function useOwner(): Disclosures {
  const owner = useDisclosures();
  if (!owner) throw new Error("Disclosure requires a DisclosuresContext");
  return owner;
}

/** Read or forward intent without keeping a second copy of the open bit. */
export function useDisclosure(
  kind: DisclosureKind,
  identity: DisclosureIdentity,
  input?: DisclosureContextInput,
): DisclosureState {
  return useOwner().bind(kind, identity, input);
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
  variant: "label";
  label: string;
  lead?: () => Element;
  meta?: () => Element;
  hasContent: () => boolean;
  focusHome?: () => void;
  children?: (open: () => boolean) => Element;
  outgoing?: boolean;
  /** The enclosing layout already owns the icon and caption tracks. */
  trackAligned?: boolean;
}

/** Label variant of the shared in-flow disclosure. */
export default function Disclosure(props: DisclosureProps): Element {
  const owner = useOwner();
  const [revision, publish] = createSignal(0);
  const binding = createMemo(() =>
    owner.bind(props.kind, props.identity, props.input)
  );
  onCleanup(owner.subscribe(() => publish((n) => n + 1)));
  const visible = () => {
    revision();
    return binding().open();
  };
  const ancestor = useContext(DisclosureFocusContext);
  const id = createUniqueId();
  let frame: HTMLDivElement | undefined;
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
      {props.lead?.()}
      <span class="otk-disclosure-label otk-control-label" title={props.label}>
        {props.label}
      </span>
      {props.meta?.()}
    </>
  );
  const change = (value: boolean, event: MouseEvent | KeyboardEvent) => {
    if (value === visible()) return;
    if (!value && region?.contains(document.activeElement)) focus();
    discloseInViewport(
      frame,
      value,
      (next) => void binding().set(next),
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
  function Frame() {
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
          if (!ancestor?.()) props.focusHome?.();
        }
      });
    });
    return (
      <div class="otk-disclosure-frame" ref={(el) => frame = el}>
        <button
          type="button"
          class={[
            "otk-disclosure-button",
            {
              "is-outgoing": props.outgoing,
              "is-track-aligned": props.trackAligned,
            },
          ]}
          ref={(el) => trigger = el}
          aria-expanded={visible() ? "true" : "false"}
          aria-controls={id}
          onClick={(event) => change(!visible(), event)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            change(event.key === "ArrowRight", event);
          }}
        >
          <DisclosureIcon open={visible()} />
          {label()}
        </button>
        <div
          class="otk-disclosure-region"
          id={id}
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
      </div>
    );
  }
  return (
    <Show
      when={props.hasContent()}
      fallback={
        <Show when={DISCLOSURE_KINDS[props.kind].empty === "leaf"}>
          <div class="otk-disclosure-leaf">
            <span />
            {label()}
          </div>
        </Show>
      }
    >
      <Frame />
    </Show>
  );
}
