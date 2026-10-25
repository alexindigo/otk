// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentSession,
  IndexEntry,
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

export interface SessionActions {
  key(): string;
  selectedEntry(): IndexEntry | undefined;
  info(): ContentSession | undefined;
  directory(target: Selection): Promise<string>;
  act<T>(target: Selection, action: () => Promise<T>): Promise<T>;
  submission(target: Selection): SessionSubmission;
  attachments(parts: PromptPart[], sidecarId: string): Promise<PromptPart[]>;
  prompt(parts: PromptPart[], selection: PromptChoices): Promise<void>;
  abort(): Promise<void>;
  rename(target: Selection, title: string): Promise<ContentSession>;
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
  ): Promise<T> => {
    const path = await directory(target);
    return await resources.inbox(target.sidecarId).act(path, action);
  };
  const submission = (target: Selection): SessionSubmission =>
    createSessionSubmission({
      sessionID: target.sessionID,
      directory: () => directory(target),
      inbox: resources.inbox(target.sidecarId),
      tabs: (directory) =>
        resources.tabs({ sidecarId: target.sidecarId, directory }),
    });
  const attachments = (
    parts: PromptPart[],
    sidecarId: string,
  ): Promise<PromptPart[]> =>
    Promise.all(
      parts.map((part) =>
        part.kind === "file" && part.source === "history"
          ? resources.sidecars.connection(part.sidecarID || sidecarId).rpc.call(
            "history.attachment",
            { messageID: part.messageID, partID: part.partID },
          )
          : part
      ),
    );
  return {
    key() {
      const selected = session.state.selection;
      return selected ? sessionKey(selected.sidecarId, selected.sessionID) : "";
    },
    selectedEntry,
    info,
    directory,
    act,
    submission,
    attachments,
    rename(target, title) {
      const rpc = resources.sidecars.connection(target.sidecarId).rpc;
      return act(target, () =>
        rpc.call("session.rename", {
          sessionID: target.sessionID,
          title,
        }));
    },
    async prompt(parts, selection) {
      const { selection: target, rpc } = current.context();
      await submission(target)(async () => {
        await rpc.call("session.prompt", {
          sessionID: target.sessionID,
          mode: "normal",
          parts: await attachments(parts, target.sidecarId),
          ...selection,
        });
      });
    },
    async abort() {
      const { selection: target, rpc } = current.context();
      await act(
        target,
        () => rpc.call("session.abort", { sessionID: target.sessionID }),
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
            ? rpc.call("question.reply", { ...input, answers: input.answers })
            : rpc.call("question.reject", input),
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
