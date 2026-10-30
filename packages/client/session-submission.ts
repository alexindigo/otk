// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxModel } from "./inbox.ts";
import type { ClientTabs } from "./tabs.ts";
import type { IntentGroup, RequestOptions } from "./requests.ts";

/** Every session submission, independent of its mode-specific transport. */
export interface SessionSubmission {
  <T>(action: (options?: RequestOptions) => Promise<T>): Promise<T>;
}

/** Bind identity and owners before asynchronous admission; never read selection. */
export function createSessionSubmission({
  sessionID,
  directory,
  inbox,
  tabs,
  wrap,
  group,
}: {
  sessionID: string;
  directory(): Promise<string>;
  inbox: Pick<InboxModel, "act">;
  tabs(directory: string): Pick<ClientTabs, "send">;
  /** Session-owned completion lifetime around the same real admission port. */
  wrap?: SessionSubmission;
  group?(): IntentGroup;
}): SessionSubmission {
  const admit: SessionSubmission = async (action) => {
    const intent = group?.();
    const promotion = intent?.options("promote", sessionID);
    const send = intent?.options("send", sessionID);
    const visit = intent?.options("visit", sessionID);
    const project = await directory();
    return await tabs(project).send(
      sessionID,
      () => inbox.act(project, () => action(send), visit),
      promotion,
    );
  };
  return (action) => wrap ? wrap(() => admit(action)) : admit(action);
}
