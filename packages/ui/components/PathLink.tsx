// SPDX-License-Identifier: LGPL-3.0-only
import "./PathLink.css" with { type: "text" };
import {
  createContext,
  createEffect,
  createSignal,
  createUniqueId,
  type Element,
  Show,
  useContext,
} from "solid-js";
import {
  type ActionControl,
  type FileFacts,
  type PathMention,
  pathTooltip,
} from "@otk/client";
import type { PathSemantics } from "@otk/protocol";
import { useContentIdentity } from "../features/transcript-context.tsx";
import type { FileTarget } from "../features/file-paths.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import { contextTarget } from "./context-target.ts";
import ActionButton from "./ActionButton.tsx";

export const PathContext = createContext<
  {
    readonly streaming: boolean;
    readonly style?: PathSemantics["style"];
    readonly inLink?: boolean;
  } | null
>(null);
export interface FilePathPorts {
  facts(id: string): FileFacts;
  openMenu(element: HTMLElement): void;
  fail(cause: unknown): void;
}
export const FilePathServices = createContext<FilePathPorts | null>(null);

export default function PathLink(
  props: { mention: PathMention; children: Element },
): Element {
  const identity = useContentIdentity(),
    paths = useContext(PathContext),
    services = useContext(FilePathServices);
  const { commands } = useCommandPorts();
  const [lease, setLease] = createSignal<ReturnType<FileFacts["fact"]>>();
  const id = `file-path-${createUniqueId()}`;
  createEffect(
    () =>
      !paths?.streaming && services && identity.sessionID
        ? {
          path: props.mention.path,
          sessionID: identity.sessionID,
          sidecarId: identity.sidecarId ?? "local",
        }
        : undefined,
    (input) => {
      const value = input &&
        services?.facts(input.sidecarId).fact(input.sessionID, input.path);
      setLease(() => value);
      return value?.release;
    },
  );
  const target = (): FileTarget | undefined => {
    const fact = lease()?.();
    if (
      !identity.sessionID || paths?.streaming || !fact ||
      (fact.status !== "file" && fact.status !== "directory")
    ) return;
    return {
      sessionID: identity.sessionID,
      sidecarId: identity.sidecarId ?? "local",
      mention: props.mention,
      fact,
    };
  };
  return (
    <Show when={target()} fallback={props.children}>
      {(data) => {
        let element: HTMLElement;
        const action: ActionControl = {
          availability: () => ({ available: true }),
          subscribe: (listener) => commands.subscribe(listener),
          async run() {
            const input = data();
            if (input.fact.preview === "none") {
              services?.openMenu(element);
            } else {
              try {
                await commands.run("file.open", input);
              } catch (cause) {
                services?.fail(cause);
              }
            }
            return { kind: "shown" };
          },
        };
        const bind = contextTarget(() => ({ kind: "file", data: data() }));
        return (
          <ActionButton
            id={id}
            class="otk-path-link"
            inline={data().fact.preview === "none"
              ? { popup: "menu", description: "Shows file actions" }
              : { popup: "dialog", description: "Opens a preview" }}
            title={pathTooltip(data().fact)}
            action={action}
            onFeedback={() => {}}
            ref={(node) => {
              element = node;
              bind(node);
            }}
          >
            {props.children}
          </ActionButton>
        );
      }}
    </Show>
  );
}
