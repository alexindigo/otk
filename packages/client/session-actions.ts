// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentSession,
  IndexEntry,
  ModelRef,
  PermissionReply,
  PromptPart,
} from "@otk/protocol";
import type { CurrentClient } from "./current.ts";
import { liveSessionInfo, sessionKey } from "./index.ts";
import type { PromptChoices } from "./prompt-selection.ts";
import { projectName } from "./project-navigation.ts";
import type { ServerResources } from "./server-resources.ts";
import type { ClientSession, Selection } from "./session.ts";
import {
  createSessionSubmission,
  type SessionSubmission,
} from "./session-submission.ts";
import { familySelection, familyTask, sessionFamily } from "./session-tree.ts";
import { IntentGroup, type RequestOptions } from "./requests.ts";
import type { InboxRpc } from "./inbox.ts";
import { prepareAttachments } from "./attachment-batches.ts";
import type { BranchHistory } from "./branch-history.ts";
import {
  createSessionDelivery,
  type SessionDelivery,
} from "./session-delivery.ts";
import type { StateFactory } from "./state.ts";
import { pendingMessage, pendingMessageID } from "./pending-send.ts";

export interface SessionActions {
  delivery(target: Selection): SessionDelivery;
  stop(): void;
  rpc(target: Selection): InboxRpc["call"];
  eligibility(
    target: Selection,
  ): { live: boolean; member: boolean; close: boolean };
  removeFromTask(target: Selection): Promise<void>;
  key(): string;
  selectedEntry(): IndexEntry | undefined;
  info(): ContentSession | undefined;
  directory(target: Selection): Promise<string>;
  act<T>(
    target: Selection,
    action: () => Promise<T>,
    options?: RequestOptions,
  ): Promise<T>;
  submission(target: Selection): SessionSubmission;
  group(target: Selection): IntentGroup;
  attachments(parts: PromptPart[], sidecarId: string): Promise<PromptPart[]>;
  prompt(parts: PromptPart[], selection: PromptChoices): Promise<void>;
  abort(target?: Selection, options?: RequestOptions): Promise<void>;
  rename(target: Selection, title: string): Promise<ContentSession>;
  archive(target: Selection, archived: boolean): Promise<ContentSession>;
  remove(target: Selection): Promise<void>;
  fork(target: Selection, through?: string): Promise<ContentSession>;
  compact(target: Selection, model: ModelRef): Promise<void>;
  revert(
    target: Selection,
    messageID: string,
    options?: RequestOptions,
    code?: boolean,
  ): Promise<ContentSession>;
  restore(target: Selection, options?: RequestOptions): Promise<ContentSession>;
  working(target: Selection): boolean;
  familyEntries(target: Selection): IndexEntry[];
  permission(input: PermissionReply & { sidecarId?: string }): Promise<void>;
  question(input: { requestID: string; answers?: string[][] }): Promise<void>;
  location(target: Selection, id: string): string;
  inTask(target: Selection): boolean;
  family(selection: Selection): Selection;
  child(id: string): Selection;
}
/** Session-bound operations capture their target before asynchronous resolution. */
export function createSessionActions(o: {
  resources: ServerResources;
  session:
    & Pick<ClientSession, "state">
    & Partial<Pick<ClientSession, "transcripts">>;
  factory?: StateFactory;
  promptBlocks?(text: string): import("@otk/protocol").Block[];
  current: CurrentClient;
  branchHistory?: Pick<BranchHistory, "prepare" | "beforeCommit" | "settled">;
  /** Wrap the common submission lifetime, including shell/native commands. */
  submitted?<T>(target: Selection, action: () => Promise<T>): Promise<T>;
}): SessionActions {
  const { resources, session, current } = o;
  const deliveries = new Map<string, SessionDelivery>();
  const delivery = (target: Selection) => {
    const key = sessionKey(target.sidecarId, target.sessionID);
    let value = deliveries.get(key);
    if (!value) {
      value = createSessionDelivery({
        target: { ...target },
        factory: o.factory,
        title: () => resources.entry(target.sidecarId, target.sessionID)?.title,
        transcript: () => session.transcripts?.get(target),
      });
      deliveries.set(key, value);
    }
    return value;
  };
  const selectedEntry = (): IndexEntry | undefined => {
    const target = session.state.selection;
    return target
      ? resources.entry(target.sidecarId, target.sessionID)
      : undefined;
  };
  const info = (): ContentSession | undefined =>
    liveSessionInfo(session.state.info, selectedEntry());
  const directory = async (target: Selection): Promise<string> => {
    const known = resources.entry(target.sidecarId, target.sessionID);
    if (known) return known.directory;
    const selected = info();
    if (
      selected?.id === target.sessionID &&
      session.state.selection?.sidecarId === target.sidecarId
    ) return selected.directory;
    return (await resources.sidecars.connection(target.sidecarId).rpc.call(
      "session.get",
      { sessionID: target.sessionID },
    )).directory;
  };
  const act = async <T>(
    target: Selection,
    action: (directory: string) => Promise<T>,
    options?: RequestOptions,
  ): Promise<T> => {
    const visit = options ??
      new IntentGroup(
        resources.sidecars.connection(target.sidecarId).rpc.intent(),
      ).options("visit", target.sessionID);
    const path = await directory(target);
    if (resources.entry(target.sidecarId, target.sessionID)?.deleted) {
      throw new Error("This session was deleted from the agent service");
    }
    return await resources.inbox(target.sidecarId).act(path, () => {
      if (resources.entry(target.sidecarId, target.sessionID)?.deleted) {
        throw new Error("This session was deleted from the agent service");
      }
      return action(path);
    }, visit);
  };
  const submission = (
    target: Selection,
    captured?: IntentGroup,
  ): SessionSubmission =>
    createSessionSubmission({
      sessionID: target.sessionID,
      group: () =>
        captured ??
          new IntentGroup(
            resources.sidecars.connection(target.sidecarId).rpc.intent(),
          ),
      directory: () => directory(target),
      inbox: resources.inbox(target.sidecarId),
      tabs: (directory) =>
        resources.tabs({ sidecarId: target.sidecarId, directory }),
      wrap: (action) => {
        const admit = () => {
          if (resources.entry(target.sidecarId, target.sessionID)?.deleted) {
            return Promise.reject(
              new Error("This session was deleted from the agent service"),
            );
          }
          return (async () => {
            await o.branchHistory?.beforeCommit(target);
            try {
              return await action();
            } finally {
              await o.branchHistory?.settled(target);
            }
          })();
        };
        return o.submitted ? o.submitted(target, admit) : admit();
      },
    });
  const attachments = async (
    parts: PromptPart[],
    sidecarId: string,
  ): Promise<PromptPart[]> => {
    if (!parts.some((part) => part.kind === "file")) return parts;
    const policy = resources.sidecars.connection(sidecarId).attachments;
    if (!policy) throw new Error("Attachment policy is not available yet");
    return await prepareAttachments(
      parts,
      sidecarId,
      policy,
      async (origin, refs) =>
        (await resources.sidecars.connection(origin).rpc.call(
          "history.attachments",
          { refs },
        )).items,
    );
  };
  const working = (target: Selection) => {
    const status = resources.entry(target.sidecarId, target.sessionID)?.status;
    return !!status && status !== "idle";
  };
  return {
    delivery,
    stop() {
      for (const owner of deliveries.values()) owner.stop();
      deliveries.clear();
    },
    rpc: (target) => (method, params, input) =>
      resources.sidecars.connection(target.sidecarId).rpc.call(
        method,
        params,
        input instanceof AbortSignal
          ? { signal: input, owner: target.sessionID }
          : { ...input, owner: target.sessionID },
      ),
    eligibility(target) {
      const entry = resources.entry(target.sidecarId, target.sessionID);
      const member = resources.inbox(target.sidecarId).state.inbox.tasks.some((
        task,
      ) => task.sessions.includes(target.sessionID));
      const shown = session.state.selection?.sidecarId === target.sidecarId &&
        session.state.selection.sessionID === target.sessionID;
      const tabs = entry &&
        resources.tabs({
          sidecarId: target.sidecarId,
          directory: entry.directory,
        });
      return {
        live: !entry?.deleted,
        member,
        close: shown ||
          !!tabs?.tabs().some((tab) => tab.sessions.includes(target.sessionID)),
      };
    },
    async removeFromTask(target) {
      const entry = resources.entry(target.sidecarId, target.sessionID);
      if (!entry) return;
      const project = {
        sidecarId: target.sidecarId,
        directory: entry.directory,
      };
      const task = resources.inbox(target.sidecarId).state.inbox.tasks.find((
        task,
      ) => task.sessions.includes(target.sessionID));
      if (task) {
        await resources.taskActions(project).remove(task, target.sessionID);
      }
      if (
        session.state.selection?.sidecarId === target.sidecarId &&
        session.state.selection.sessionID === target.sessionID
      ) resources.tabs(project).preview(target.sessionID);
    },
    key() {
      const selected = session.state.selection;
      return selected ? sessionKey(selected.sidecarId, selected.sessionID) : "";
    },
    selectedEntry,
    info,
    directory,
    act,
    submission,
    group: (target) =>
      new IntentGroup(
        resources.sidecars.connection(target.sidecarId).rpc.intent(),
      ),
    attachments,
    working,
    familyEntries: (target) =>
      resources.entries().filter((entry) =>
        entry.sidecarId === target.sidecarId &&
        sessionFamily(entry.id, (id) => resources.entry(target.sidecarId, id))
          .includes(target.sessionID)
      ),
    remove(target) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      return rpc.intents.run(`delete:${target.sessionID}`, (group) => {
        const interrupt = group.options("interrupt", target.sessionID);
        const remove = group.options("delete", target.sessionID);
        const visit = group.options("visit", target.sessionID);
        return act(target, async () => {
          if (working(target)) {
            await rpc.call(
              "session.abort",
              { sessionID: target.sessionID },
              interrupt,
            );
          }
          await rpc.call(
            "session.delete",
            { sessionID: target.sessionID },
            remove,
          );
        }, visit);
      });
    },
    fork(target, through) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      return act(
        target,
        () =>
          rpc.call("session.fork", { sessionID: target.sessionID, through }),
      );
    },
    async compact(target, model) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      await act(
        target,
        async () => {
          await o.branchHistory?.beforeCommit(target);
          try {
            return await rpc.call("session.compact", {
              sessionID: target.sessionID,
              model,
            });
          } finally {
            await o.branchHistory?.settled(target);
          }
        },
      );
    },
    rename(target, title) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      return act(
        target,
        (directory) =>
          resources.tabs({ sidecarId: target.sidecarId, directory }).rename(
            target.sessionID,
            title,
            () =>
              rpc.call("session.rename", {
                sessionID: target.sessionID,
                title,
              }),
          ),
      );
    },
    archive(target, archived) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      return act(
        target,
        () =>
          rpc.call("session.archive", {
            sessionID: target.sessionID,
            archived,
          }),
      );
    },
    revert(target, messageID, options, code = false) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      return act(
        target,
        async () => {
          const result = await rpc.call(
            code ? "session.revertCode" : "session.revert",
            {
              sessionID: target.sessionID,
              messageID,
            },
            options,
          );
          // Staging is reversible. Preservation gates the next committing send,
          // while its owner retains any background failure through FP1.
          if (result.revert) {
            void o.branchHistory?.prepare(target, messageID).catch(() => {});
          }
          return result;
        },
      );
    },
    restore(target, options) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      return act(
        target,
        async () => {
          const result = await rpc.call("session.restore", {
            sessionID: target.sessionID,
          }, options);
          await o.branchHistory?.settled(target, true);
          return result;
        },
      );
    },
    async prompt(parts, selection) {
      const { selection: target, rpc } = current.context();
      const group = new IntentGroup(rpc.intent());
      const intent = group.options("send", target.sessionID).intent!;
      const messageID = pendingMessageID(intent);
      const message = pendingMessage(
        messageID,
        target.sessionID,
        parts,
        o.promptBlocks,
      );
      const send = (captured: IntentGroup): Promise<void> =>
        delivery(target).send(
          (dispatch) =>
            submission(target, captured)(async (options) => {
              const prepared = await attachments(parts, target.sidecarId);
              const transcript = session.transcripts?.get(target);
              const pending = transcript?.projection.entry(messageID)?.send;
              if (pending && pending.phase !== "committed") {
                transcript?.send?.({
                  ...pending,
                  message: {
                    ...pending.message,
                    parts: pendingMessage(
                      messageID,
                      target.sessionID,
                      prepared,
                      o.promptBlocks,
                    ).parts,
                  },
                });
              }
              dispatch();
              return await rpc.call("session.prompt", {
                sessionID: target.sessionID,
                messageID,
                mode: "normal",
                parts: prepared,
                ...selection,
              }, options);
            }),
          {
            intent,
            message,
            phase: "pending",
            retry: () => {
              void send(new IntentGroup(rpc.intent())).catch((cause) => {
                console.error("Pending-send retry diagnostic", target, cause);
              });
            },
          },
        );
      await send(group);
    },
    async abort(target = current.context().selection, options) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      await act(
        target,
        () =>
          rpc.call("session.abort", { sessionID: target.sessionID }, options),
      );
    },
    async permission(input) {
      const { sidecarId, ...reply } = input;
      const id = sidecarId ?? current.context().selection.sidecarId;
      await act(
        { sidecarId: id, sessionID: reply.sessionID },
        () =>
          resources.sidecars.connection(id).rpc.call("permission.reply", reply),
      );
    },
    async question(input) {
      const { selection: target, rpc } = current.context();
      const asking =
        session.state.content.questions.find((request) =>
          request.id === input.requestID
        )?.sessionID ?? target.sessionID;
      const options = {
        owner: target.sessionID,
        facts: {
          target: {
            sidecarId: target.sidecarId,
            sessionID: asking,
            label: resources.entry(target.sidecarId, asking)?.title,
          },
        },
      };
      await act(
        target,
        () =>
          input.answers
            ? rpc.call(
              "question.reply",
              { ...input, answers: input.answers },
              options,
            )
            : rpc.call("question.reject", input, options),
      );
    },
    location(target, id) {
      const value = resources.entry(target.sidecarId, id);
      const task = familyTask(
        resources.inbox(target.sidecarId).state.inbox.tasks,
        [id, target.rootID ?? target.sessionID],
      );
      return [value && projectName(value.directory), task?.name ?? value?.title]
        .filter(Boolean).join(", ");
    },
    inTask(target) {
      const value = resources.entry(target.sidecarId, target.sessionID);
      if (!value) return false;
      if (value.hierarchy) return !!value.hierarchy.taskID;
      return !!familyTask(
        resources.inbox(target.sidecarId).state.inbox.tasks,
        sessionFamily(
          target.sessionID,
          (id) => resources.entry(target.sidecarId, id),
        ),
        value.directory,
      );
    },
    family: (selection) =>
      familySelection(
        selection,
        (id) => resources.entry(selection.sidecarId, id),
      ),
    child(id) {
      const selected = session.state.selection!;
      return {
        sidecarId: selected.sidecarId,
        sessionID: id,
        ...(resources.entry(selected.sidecarId, id)
          ? {}
          : { rootID: selected.rootID || selected.sessionID }),
      };
    },
  };
}
