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
  type CodeBlockSource,
  createTranscriptInteraction,
  type DisclosureKind,
  type NativeSourceOwner,
  recordKindDisclosure,
  recordKindKey,
  type TranscriptInteraction,
} from "@otk/client";
import type { DisclosureCategory, Preferences } from "@otk/protocol";
import { copyText } from "../clipboard.ts";
import { DisclosuresContext } from "../components/Disclosure.tsx";

/** Both visible reply actions and context commands copy the captured source. */
export function copyContent(value: string): Promise<void> {
  return copyText(value);
}

/** Shared target data is extensible without importing a message or tool view. */
export interface ContentIdentity {
  /** Stable presentation lifetime, separate from native action boundaries. */
  ownerID?: string;
  sidecarId?: string;
  sessionID?: string;
  label?: string;
  messageID?: string;
  partID?: string;
  callID?: string;
  directory?: string;
}
export interface ContentTarget extends ContentIdentity {
  code?: CodeBlockSource;
  runText?: string;
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
type SourceReader = (
  ref: string,
) => NativeSourceOwner;
const Sources = createContext<SourceReader | null>(null);
/** The transcript's on-demand reader for plugin-owned source references. */
export function useNativeSource(): SourceReader | null {
  return useContext(Sources);
}
/** A saved presentation cannot borrow a live transcript's source reader, action
 * ports, visibility observer or disclosure identities. It has no native demand. */
export function TranscriptSnapshot(props: { children: Element }): Element {
  const interaction = createTranscriptInteraction();
  return (
    <Sources value={null}>
      <Actions value={null}>
        <Visibility value={null}>
          <Interaction value={interaction}>
            <DisclosuresContext value={interaction.disclosures}>
              {props.children}
            </DisclosuresContext>
          </Interaction>
        </Visibility>
      </Actions>
    </Sources>
  );
}
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
/** The client resolves defaults; this binding only publishes an explicit intent. */
export function retainedDisclosure(
  kind: DisclosureKind,
  category: DisclosureCategory | (() => DisclosureCategory),
  prefs: () => Partial<Preferences> = () => ({}),
  identity = useContentIdentity(),
  required: () => boolean = () => false,
  ownerKey?: string,
) {
  const interaction = useContext(Interaction) ?? createTranscriptInteraction();
  const id = identity.partID ?? identity.ownerID ?? identity.messageID ?? kind;
  const disclosureKey = ownerKey ?? key(identity);
  const generation = interaction.generation(ownerKey ?? id);
  const choice = interaction.disclosure(
    kind,
    disclosureKey,
    generation,
  );
  const [revision, setRevision] = createSignal(0);
  onCleanup(
    interaction.subscribe(
      () => setRevision((value) => value + 1),
      kind,
      disclosureKey,
      generation,
    ),
  );
  const expanded = () => {
    revision();
    return choice.expanded(
      typeof category === "function" ? category() : category,
      prefs(),
      required(),
    );
  };
  return [expanded, (open: boolean) => {
    choice.set(open);
  }] as const;
}

/** Work membership may change without changing the reader's disclosure intent. */
export function retainedWorkDisclosure(
  scope: string,
  prefs: () => Partial<Preferences>,
  required: () => boolean,
) {
  const interaction = useContext(Interaction) ?? createTranscriptInteraction();
  const [revision, setRevision] = createSignal(0);
  onCleanup(interaction.subscribeWork(scope, () => setRevision((n) => n + 1)));
  const choice = interaction.workDisclosure(scope);
  return [
    () => {
      revision();
      return choice.expanded("work", prefs(), required());
    },
    (open: boolean) => choice.set(open),
  ] as const;
}

const key = (identity: ContentIdentity) =>
  JSON.stringify([
    identity.sidecarId,
    identity.sessionID,
    identity.ownerID ?? identity.messageID,
    identity.partID,
    identity.callID,
  ]);
/** Category choices share the transcript interaction lifetime, never the DOM. */
export function retainedRecordKinds(owner: () => string) {
  const interaction = useContext(Interaction) ?? createTranscriptInteraction();
  const [revision, setRevision] = createSignal(0);
  const subscriptions = new Map<string, () => void>();
  onCleanup(() => {
    for (const release of subscriptions.values()) release();
  });
  const choice = (category: DisclosureCategory) => {
    const frame = owner();
    const id = recordKindKey(frame, category);
    if (!subscriptions.has(id)) {
      subscriptions.set(
        id,
        interaction.subscribe(
          () => setRevision((n) => n + 1),
          "recordKinds",
          id,
          interaction.generation(frame),
        ),
      );
    }
    return recordKindDisclosure(interaction, frame, category);
  };
  return {
    expanded(category: DisclosureCategory, prefs: Partial<Preferences>) {
      revision();
      return choice(category).expanded(category, prefs);
    },
    set(category: DisclosureCategory, open: boolean) {
      choice(category).set(open);
    },
  };
}
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
    nativeSource?: SourceReader;
    visibility?(
      element: HTMLElement,
      messageID: string,
    ): (() => void) | undefined;
  },
): Element {
  const ports = useCommandPorts();
  const shared = useContext(DisclosuresContext);
  const interaction = props.interaction ??
    createTranscriptInteraction(shared ?? undefined);
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
    ]
  ) {
    ownedCommand(ports, {
      id: `${kind}.copy`,
      title,
      category: "Transcript",
      arguments: { type: "object" },
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
      arguments: { type: "object" },
      context: { kind: "tool" },
      enabled: (_ctx, target?: ContentTarget) => !!target?.[source],
      run: (_ctx, target: ContentTarget) => copyContent(target[source]!),
    });
  }
  ownedCommand(ports, {
    id: "tool.toggle",
    title: "Expand",
    category: "Transcript",
    arguments: { type: "object" },
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
    arguments: { type: "object" },
    context: { kind: "reply", order: 10 },
    enabled: (_ctx, target?: ContentTarget) => !!owner(target)?.usage,
    run: (_ctx, target: ContentTarget) => owner(target)?.usage?.(),
  });
  return (
    <Visibility value={props.visibility ?? null}>
      <Sources value={props.nativeSource ?? null}>
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
            <DisclosuresContext value={shared ?? interaction.disclosures}>
              {props.children}
            </DisclosuresContext>
          </Actions>
        </Interaction>
      </Sources>
    </Visibility>
  );
}
