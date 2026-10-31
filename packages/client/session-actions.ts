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

export interface SessionActions {
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
  remove(target: Selection): Promise<void>;
  fork(target: Selection, through?: string): Promise<ContentSession>;
  compact(target: Selection, model: ModelRef): Promise<void>;
  revert(
    target: Selection,
    messageID: string,
    options?: RequestOptions,
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
  session: Pick<ClientSession, "state">;
  current: CurrentClient;
  /** Wrap the common submission lifetime, including shell/native commands. */
  submitted?<T>(target: Selection, action: () => Promise<T>): Promise<T>;
}): SessionActions {
  const { resources, session, current } = o;
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
    action: () => Promise<T>,
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
      return action();
    }, visit);
  };
  const submission = (target: Selection): SessionSubmission =>
    createSessionSubmission({
      sessionID: target.sessionID,
      group: () =>
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
          return action();
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
        () =>
          rpc.call("session.compact", { sessionID: target.sessionID, model }),
      );
    },
    rename(target, title) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      return act(target, () =>
        rpc.call("session.rename", {
          sessionID: target.sessionID,
          title,
        }));
    },
    revert(target, messageID, options) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      return act(
        target,
        () =>
          rpc.call("session.revert", {
            sessionID: target.sessionID,
            messageID,
          }, options),
      );
    },
    restore(target, options) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      return act(
        target,
        () =>
          rpc.call("session.restore", { sessionID: target.sessionID }, options),
      );
    },
    async prompt(parts, selection) {
      const { selection: target, rpc } = current.context();
      await submission(target)(async (options) => {
        await rpc.call("session.prompt", {
          sessionID: target.sessionID,
          mode: "normal",
          parts: await attachments(parts, target.sidecarId),
          ...selection,
        }, options);
      });
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
      await act(
        target,
        () =>
          input.answers
            ? rpc.call("question.reply", { ...input, answers: input.answers }, {
              owner: target.sessionID,
            })
            : rpc.call("question.reject", input, { owner: target.sessionID }),
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
