// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxModel } from "./inbox.ts";
import type { ClientTabs } from "./tabs.ts";

/** Every session submission, independent of its mode-specific transport. */
export interface SessionSubmission {
  <T>(action: () => Promise<T>): Promise<T>;
}

/** Bind identity and owners before asynchronous admission; never read selection. */
export function createSessionSubmission({
  sessionID,
  directory,
  inbox,
  tabs,
}: {
  sessionID: string;
  directory(): Promise<string>;
  inbox: Pick<InboxModel, "act">;
  tabs(directory: string): Pick<ClientTabs, "send">;
}): SessionSubmission {
  return async (action) => {
    const project = await directory();
    return await tabs(project).send(
      sessionID,
      () => inbox.act(project, action),
    );
  };
}
