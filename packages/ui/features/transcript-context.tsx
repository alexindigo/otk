// SPDX-License-Identifier: LGPL-3.0-only
import {
  createContext,
  createEffect,
  createSignal,
  type Element,
  onCleanup,
  onSettled,
  useContext,
} from "solid-js";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import {
  createTranscriptInteraction,
  type TranscriptInteraction,
} from "@otk/client";

/** Both visible reply actions and context commands copy the captured source. */
export function copyContent(value: string): Promise<void> {
  return navigator.clipboard.writeText(value);
}

/** Shared target data is extensible without importing a message or tool view. */
export interface ContentIdentity {
  /** Stable presentation lifetime, separate from native action boundaries. */
  ownerID?: string;
  sidecarId?: string;
  sessionID?: string;
  messageID?: string;
  partID?: string;
  callID?: string;
  directory?: string;
}
export interface ContentTarget extends ContentIdentity {
  lastID?: string;
  completed?: boolean;
  queued?: boolean;
  text?: string;
  source?(): string | Promise<string>;
  command?: string;
  path?: string;
  paths?: string;
  output?: string;
}
interface ContentOwner {
  expanded?(): boolean;
  toggle?(): void;
  usage?(): void | Promise<void>;
}
interface ContentActions {
  bind(identity: ContentIdentity, owner: ContentOwner): () => void;
}
const Identity = createContext<ContentIdentity>({});
const Actions = createContext<ContentActions | null>(null);
const Interaction = createContext<TranscriptInteraction | null>(null);
export function contentGeneration() {
  const interaction = useContext(Interaction);
  return (id: string) => interaction?.generation(id) ?? id;
}
const Visibility = createContext<
  ((element: HTMLElement, messageID: string) => (() => void) | undefined) | null
>(null);
export function sourceRegion(messageID: () => string) {
  const attach = useContext(Visibility);
  const [element, setElement] = createSignal<HTMLElement>();
  let release: (() => void) | undefined;
  createEffect(
    () => ({ element: element(), id: messageID() }),
    ({ element, id }) => {
      release?.();
      release = element && id ? attach?.(element, id) : undefined;
    },
  );
  onCleanup(() => release?.());
  return (element: HTMLElement) => {
    setElement(element);
  };
}
/** A disclosure owns only its explicit choice; expensive content is a factory. */
export function retainedDisclosure(
  kind: string,
  identity = useContentIdentity(),
) {
  const interaction = useContext(Interaction);
  const id = identity.partID ?? identity.ownerID ?? identity.messageID ?? kind;
  const choice = interaction?.disclosure(
    key(identity) + ":" + kind,
    interaction.generation(id),
  );
  const [value, setValue] = createSignal<boolean | undefined>(choice?.value());
  return [value, (open: boolean) => {
    choice?.set(open);
    setValue(open);
  }] as const;
}
const key = (identity: ContentIdentity) =>
  JSON.stringify([
    identity.sidecarId,
    identity.sessionID,
    identity.ownerID ?? identity.messageID,
    identity.partID,
    identity.callID,
  ]);
export function ContentIdentityProvider(
  props: { value: ContentIdentity; children: Element },
): Element {
  return <Identity value={props.value}>{props.children}</Identity>;
}
export function useContentIdentity(): ContentIdentity {
  return useContext(Identity);
}
/** Only stateful operations retain ports; copied source stays in invocation data. */
export function contentOwner(
  identity: () => ContentIdentity,
  owner: ContentOwner,
): void {
  const actions = useContext(Actions);
  onSettled(() => actions?.bind(identity(), owner));
}
/** One feature owner per transcript, independent of message/part population. */
export function TranscriptContext(
  props: {
    children: Element;
    interaction?: TranscriptInteraction;
    visibility?(
      element: HTMLElement,
      messageID: string,
    ): (() => void) | undefined;
  },
): Element {
  const ports = useCommandPorts();
  const interaction = props.interaction ?? createTranscriptInteraction();
  const owners = new Map<string, ContentOwner>();
  const [revision, setRevision] = createSignal(0);
  const owner = (target?: ContentIdentity) => {
    revision();
    return target && owners.get(key(target));
  };
  for (
    const [kind, title] of [
      ["prompt", "Copy prompt"],
      ["reply", "Copy reply"],
      ["code", "Copy code"],
      ["diff", "Copy code"],
    ]
  ) {
    ownedCommand(ports, {
      id: `${kind}.copy`,
      title,
      category: "Transcript",
      hidden: true,
      context: { kind },
      enabled: (_ctx, target?: ContentTarget) =>
        !!target?.source || !!target?.text,
      run: async (_ctx, target: ContentTarget) =>
        copyContent(target.source ? await target.source() : target.text!),
    });
  }
  for (
    const [source, title] of [
      ["command", "Copy command"],
      ["path", "Copy path"],
      ["paths", "Copy paths"],
      ["output", "Copy output"],
    ] as const
  ) {
    ownedCommand(ports, {
      id: `tool.copy.${source}`,
      title,
      category: "Transcript",
      hidden: true,
      context: { kind: "tool" },
      enabled: (_ctx, target?: ContentTarget) => !!target?.[source],
      run: (_ctx, target: ContentTarget) => copyContent(target[source]!),
    });
  }
  ownedCommand(ports, {
    id: "tool.toggle",
    title: "Expand",
    category: "Transcript",
    hidden: true,
    context: {
      kind: "tool",
      title: (target: ContentTarget) =>
        owner(target)?.expanded?.() ? "Collapse" : "Expand",
      order: 10,
    },
    enabled: (_ctx, target) => !!owner(target)?.toggle,
    run: (_ctx, target: ContentTarget) => owner(target)?.toggle?.(),
  });
  ownedCommand(ports, {
    id: "reply.usage",
    title: "Show usage breakdown",
    category: "Transcript",
    hidden: true,
    context: { kind: "reply", order: 10 },
    enabled: (_ctx, target?: ContentTarget) => !!owner(target)?.usage,
    run: (_ctx, target: ContentTarget) => owner(target)?.usage?.(),
  });
  return (
    <Visibility value={props.visibility ?? null}>
      <Interaction value={interaction}>
        <Actions
          value={{
            bind: (identity, value) => {
              const id = key(identity);
              if (owners.has(id)) {
                throw new Error(
                  "Duplicate transcript action owner",
                );
              }
              owners.set(id, value);
              setRevision((value) => value + 1);
              return () => {
                if (owners.get(id) !== value) return;
                owners.delete(id);
                setRevision((value) => value + 1);
              };
            },
          }}
        >
          {props.children}
        </Actions>
      </Interaction>
    </Visibility>
  );
}
