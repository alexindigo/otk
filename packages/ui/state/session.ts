// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ClientSession,
  createSession as clientSession,
  type ModelCatalogConnection,
  type Selection,
  type SidecarConnection,
} from "@otk/client";
import type { IndexEntry } from "@otk/protocol";
import { solidState } from "./binding.ts";
import { createEffect } from "solid-js";
export function createSession(
  connection: (id: string) => SidecarConnection,
  entry: (sidecarId: string, id: string) => IndexEntry | undefined,
  catalogConnection?: (selection: Selection) => ModelCatalogConnection,
): ClientSession {
  const session = clientSession(
    connection,
    entry,
    solidState,
    catalogConnection,
  );
  if (catalogConnection) {
    createEffect(() => {
      const selected = session.state.selection;
      return selected && catalogConnection(selected);
    }, () => session.models?.connect());
  }
  return session;
}
