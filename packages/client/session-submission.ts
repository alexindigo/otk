// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxModel } from "./inbox.ts";
import type { ClientTabs } from "./tabs.ts";
import type { IntentGroup, RequestOptions } from "./requests.ts";
import {
  ascendingID,
  type RequestOrigin,
  type SubmissionReceipt,
} from "@otk/protocol";
import type { SessionDelivery } from "./session-delivery.ts";
import type { PendingSend } from "./pending-send.ts";
import type { SendOutcome } from "./send-outcome.ts";
import type { DraftSendCapture } from "./drafts.ts";
import { reportDiagnostic } from "./diagnostics.ts";

/** Every session submission, independent of its mode-specific transport. */
export interface SessionSubmission {
  (
    action: (
      options: RequestOptions | undefined,
      dispatch: () => void,
      messageID: string,
    ) => Promise<SubmissionReceipt | null>,
    origin?: RequestOrigin,
    entry?: PendingSend,
    capture?: DraftSendCapture,
  ): Promise<SendOutcome>;
}

/** Bind identity and owners before asynchronous admission; never read selection.
 * Child identities carry no window: the request owner binds current welcome at dispatch. */
export function createSessionSubmission({
  sessionID,
  directory,
  inbox,
  tabs,
  wrap,
  group,
  delivery,
  beforeDispatch,
  report = (error) => console.debug("Send bookkeeping", error),
}: {
  sessionID: string;
  directory(): Promise<string>;
  inbox: Pick<InboxModel, "visit">;
  tabs(directory: string): Pick<ClientTabs, "ensureTask">;
  beforeDispatch?(): void;
  report?(error: unknown): void;
  /** Session-owned completion lifetime around the same real admission port. */
  wrap?<T>(action: () => Promise<T>, capture?: DraftSendCapture): Promise<T>;
  group?(): IntentGroup;
  delivery: Pick<SessionDelivery, "send">;
}): SessionSubmission {
  const admit = async (
    action: Parameters<SessionSubmission>[0],
    dispatch: () => void,
    messageID: string,
    origin: RequestOrigin,
  ): Promise<SubmissionReceipt | null> => {
    const intent = group?.();
    const promotion = intent?.options("promote", sessionID);
    const send = { ...intent?.options("send", sessionID), origin };
    const visit = intent?.options("visit", sessionID);
    // Resolve project identity for bookkeeping only. Native admission already
    // has its captured session identity, including when the index is cold.
    let project: Promise<string | undefined> | undefined;
    const bookkeep = () => {
      project ??= Promise.resolve().then(directory).catch((error) => {
        reportDiagnostic(report, error);
        return undefined;
      });
      return project;
    };
    const promote = () => {
      if (project) return;
      void bookkeep().then((path) => {
        if (path !== undefined) {
          return tabs(path).ensureTask(sessionID, promotion);
        }
      }).catch((error) => reportDiagnostic(report, error));
    };
    const result = await action(send, () => {
      beforeDispatch?.();
      dispatch();
      promote();
    }, messageID);
    promote();
    void bookkeep().then((path) => {
      if (path !== undefined) return inbox.visit(path, visit);
    }).catch((error) => reportDiagnostic(report, error));
    return result;
  };
  return (action, origin = "composer", entry, capture) => {
    const messageID = entry?.message.id ?? ascendingID("msg");
    let settle: ReturnType<DraftSendCapture["take"]>;
    return delivery.send(
      (dispatch) => {
        const run = () => admit(action, dispatch, messageID, origin);
        return wrap ? wrap(run, capture) : run();
      },
      entry,
      messageID,
      capture && {
        admit(id, check) {
          settle = capture.take(id, check);
          if (!settle) {
            throw new Error("The captured draft is no longer active.");
          }
        },
        outcome: (outcome) => settle?.(outcome),
      },
    );
  };
}
