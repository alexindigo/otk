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
  type DisclosureIdentity,
  type NativeSourceOwner,
  recordKindKey,
  type TranscriptInteraction,
  type TranscriptOwner,
  type TranscriptReply,
} from "@otk/client";
import type { DisclosureCategory } from "@otk/protocol";
import { copyText } from "../clipboard.ts";
import {
  DisclosureFocusHome,
  DisclosuresProvider,
  useDisclosures,
} from "../components/Disclosure.tsx";

/** Both visible reply actions and context commands copy the captured source. */
export function copyContent(value: string): Promise<void> {
  return copyText(value);
}

/** A paged-in reply may have copyable content before its visible fragments. */
export function replySourceIncomplete(
  records: Pick<TranscriptOwner, "projection">,
  reply: TranscriptReply,
  exhausted: boolean,
): boolean {
  const message = reply.message;
  return message.role === "assistant" && !exhausted &&
    (!records.projection.boundary(message.replyTo ?? message.id)?.firstID ||
      !records.projection.materialized(reply.firstID));
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
type RecordPlacement = NonNullable<DisclosureIdentity["placement"]>;
const Interaction = createContext<
  {
    owner: TranscriptInteraction;
    placement: RecordPlacement;
  } | null
>(null);
type SourceReader = (
  ref: string,
) => NativeSourceOwner;
const Sources = createContext<SourceReader | null>(null);
/** The transcript's on-demand reader for plugin-owned source references. */
export function useNativeSource(): SourceReader | null {
  return useContext(Sources);
}
/** Record surfaces share their source resource and lifetime, not fold intent. */
export function TranscriptRecords(props: {
  interaction: TranscriptInteraction;
  placement: RecordPlacement;
  nativeSource?: SourceReader;
  children: Element;
}): Element {
  return (
    <Sources value={props.nativeSource ?? null}>
      <Interaction
        value={{ owner: props.interaction, placement: props.placement }}
      >
        {props.children}
      </Interaction>
    </Sources>
  );
}
/** A saved presentation cannot borrow a live transcript's source reader, action
 * ports, visibility observer or disclosure identities. It has no native demand. */
export function TranscriptSnapshot(props: { children: Element }): Element {
  const interaction = createTranscriptInteraction();
  return (
    <Actions value={null}>
      <Visibility value={null}>
        <TranscriptRecords interaction={interaction} placement="transcript">
          <DisclosuresProvider owner={interaction.disclosures}>
            {props.children}
          </DisclosuresProvider>
        </TranscriptRecords>
      </Visibility>
    </Actions>
  );
}
export function contentGeneration() {
  const interaction = useContext(Interaction)?.owner;
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
/** Reuse the transcript owner's scope and generations for each presentation. */
export function transcriptDisclosureIdentity() {
  const identity = useContentIdentity();
  const interaction = useContext(Interaction);
  return (options?: {
    owner?: string;
    category?: DisclosureCategory;
    content?: ContentIdentity;
  }) => {
    const content = options?.content ?? identity;
    const owner = options?.owner;
    const id = options?.category && owner
      ? recordKindKey(owner, options.category)
      : owner ?? key(content);
    const generation = owner ?? content.partID ?? content.ownerID ??
      content.messageID ?? id;
    return interaction?.owner.identify(
      id,
      interaction.owner.generation(generation),
      interaction.placement,
    ) ?? { scope: "standalone", id };
  };
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
/** Shared by the shell's conversation and Work pane, or owned by a standalone view. */
export function TranscriptActions(props: { children: Element }): Element {
  if (useContext(Actions)) return props.children;
  const ports = useCommandPorts();
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
  );
}

/** View-local visibility and focus; record actions can span sibling surfaces. */
export function TranscriptContext(props: {
  children: Element;
  interaction?: TranscriptInteraction;
  nativeSource?: SourceReader;
  focusHome?: () => void;
  visibility?(
    element: HTMLElement,
    messageID: string,
  ): (() => void) | undefined;
}): Element {
  const shared = useDisclosures();
  const interaction = props.interaction ??
    createTranscriptInteraction(shared ?? undefined);
  return (
    <Visibility value={props.visibility ?? null}>
      <TranscriptRecords
        interaction={interaction}
        placement="transcript"
        nativeSource={props.nativeSource}
      >
        <TranscriptActions>
          <DisclosuresProvider owner={interaction.disclosures}>
            <DisclosureFocusHome value={props.focusHome ?? null}>
              {props.children}
            </DisclosureFocusHome>
          </DisclosuresProvider>
        </TranscriptActions>
      </TranscriptRecords>
    </Visibility>
  );
}
