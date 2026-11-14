// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, useContext } from "solid-js";
import type { InboxStatus } from "@otk/client";
import type { PermissionRequest } from "@otk/protocol";
export interface AttentionLampScope {
  server: string;
  session?: string;
  family?: { id: string; contains(session: string): boolean };
  project?: { directory: string; repo?: string };
}
export interface AttentionPresentation {
  permission(server: string, request: PermissionRequest): boolean;
  light(scope: AttentionLampScope, state: InboxStatus): InboxStatus;
}
const Context = createContext<AttentionPresentation | null>(null);
export function AttentionProvider(props: {
  ports: AttentionPresentation;
  children: Element;
}): Element {
  return <Context value={props.ports}>{props.children}</Context>;
}
export const useAttentionPresentation = () => useContext(Context);
