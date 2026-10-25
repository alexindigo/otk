// SPDX-License-Identifier: LGPL-3.0-only
import {
  createContext,
  createSignal,
  type Element,
  onSettled,
  useContext,
} from "solid-js";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";

/** Both visible reply actions and context commands copy the captured source. */
export function copyContent(value: string): Promise<void> {
  return navigator.clipboard.writeText(value);
}

/** Shared target data is extensible without importing a message or tool view. */
export interface ContentIdentity {
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
  command?: string;
  path?: string;
  paths?: string;
  output?: string;
}
interface ContentOwner {
  expanded?(): boolean;
  toggle?(): void;
  usage?(): void;
}
interface ContentActions {
  bind(identity: ContentIdentity, owner: ContentOwner): () => void;
}
const Identity = createContext<ContentIdentity>({});
const Actions = createContext<ContentActions | null>(null);
const key = (identity: ContentIdentity) =>
  JSON.stringify([
    identity.sidecarId,
    identity.sessionID,
    identity.messageID,
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
export function TranscriptContext(props: { children: Element }): Element {
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
      enabled: (_ctx, target?: ContentTarget) => !!target?.text,
      run: (_ctx, target: ContentTarget) => copyContent(target.text!),
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
