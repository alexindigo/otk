// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled } from "solid-js";
import { createSessionRename, createTabs } from "@otk/client";
import {
  type ContentSession,
  entityKey,
  type InboxSnapshot,
} from "@otk/protocol";
import ProjectTabs from "../../components/ProjectTabs.tsx";
import CommandMenu from "../../components/CommandMenu.tsx";
import Subagents from "../../components/Subagents.tsx";
import { useCommandPorts } from "../../keyboard/context.tsx";
import { solidState } from "../../state/binding.ts";

export default function Scene() {
  const directory = "/project";
  const tabs = createTabs(
    () => Promise.reject(new Error("No promotion expected")),
    solidState,
  );
  const rename = createSessionRename({
    rename: () => Promise.resolve(),
    factory: solidState,
  });
  const [members, setMembers] = createSignal<string[]>([]),
    [session, setSession] = createSignal<ContentSession>();
  const inbox = (ids = members()): InboxSnapshot => ({
    projects: [],
    tasks: [{
      id: "task",
      directory,
      name: "Task",
      sessions: ids,
      order: 0,
    }],
    seen: {},
    finishes: {},
    pathTemplates: [],
    entities: Object.fromEntries(
      ids.map((
        id,
      ) => [entityKey("session", id), {
        kind: "session",
        id,
        state: "working",
        previous: "none",
        counts: { working: 1, blocked: 0, finished: 0, unseen: 0 },
      }]),
    ),
  });
  const entry = (id: string, index: number, ids: string[]) => ({
    id,
    parentID: index ? ids[index - 1] : undefined,
    sidecarId: "local",
    directory,
    projectID: "p",
    title: id,
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "idle" as const,
    digest: { state: "digesting" as const, revision: 0, turns: {} },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  });
  const entries = () => members().map(entry);
  let createdSessions = 0;
  styleTest.createdSessions = () => createdSessions;
  styleTest.lists = (ids, selected = ids[0], editing) => {
    setMembers(ids);
    tabs.update({
      directory,
      entries: ids.map(entry),
      inbox: {
        ...inbox(ids),
        tasks: [{
          id: "task",
          directory,
          name: "Task",
          sessions: ids,
          order: 0,
        }],
      },
    });
    tabs.select({ kind: "task", id: "task" }, selected);
    setSession(
      selected
        ? {
          id: selected,
          directory,
          projectID: "p",
          title: selected,
          time: { created: 1, updated: 1 },
          archived: false,
        }
        : undefined,
    );
    if (editing) {
      rename.start(
        { sidecarId: "local", sessionID: editing, title: editing },
        "chip",
      );
    } else rename.cancel();
  };
  const [keys, setKeys] = createSignal(["one", "two", "delete"]);
  styleTest.menuItems = setKeys;
  const { commands } = useCommandPorts();
  let held = false,
    settlement: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  styleTest.holdMenu = (value) => {
    held = value;
  };
  styleTest.settleMenu = (failed) => {
    if (failed) settlement?.reject(new Error("private SQL /secret/path"));
    else settlement?.resolve();
  };
  onSettled(() => {
    const releases = ["one", "two", "delete"].map((id) =>
      commands.register({
        id: `list.${id}`,
        title: id,
        category: "Probe",
        context: { kind: "list-probe", destructive: id === "delete" },
        enabled: () => keys().includes(id),
        run: () => {
          if (!held) return;
          settlement = Promise.withResolvers<void>();
          return settlement.promise;
        },
      })
    );
    releases.push(commands.register({
      id: "list.open-helper",
      title: "Open subagent",
      category: "Probe",
      run: () => undefined,
    }));
    return () => releases.forEach((release) => release());
  });
  return (
    <>
      <ProjectTabs
        project={{ sidecarId: "local", directory }}
        model={tabs}
        entries={entries()}
        inbox={inbox()}
        ready
        session={session()}
        rename={rename}
        onOpen={() => true}
        onEmpty={() => true}
        onCreateSession={() => {
          createdSessions++;
          return Promise.resolve();
        }}
        actions={{
          create: () => Promise.reject(new Error("unused")),
          rename: () => Promise.resolve(),
          close: () => Promise.resolve(),
          reorder: () => Promise.resolve(),
          add: () => Promise.resolve(),
          remove: () => Promise.resolve(),
        }}
      />
      <Subagents
        entities={tabs.entities()}
        helpers={(() => {
          void tabs.state.revision;
          const store = tabs.entities(), key = tabs.trail().task;
          return key && !store.isStale ? store.get(key)?.helpers : undefined;
        })()}
        current={session()?.id ?? ""}
        title={(id) => id}
        agent={() => undefined}
        openAction={(id) =>
          commands.control("list.open-helper", undefined, {
            target: { label: id },
            shown: () => true,
            unshown: "The subagent did not open.",
            recovery: "Choose the subagent again",
          })}
      />
      <CommandMenu
        label="Reactive list menu"
        trigger="Actions"
        targets={() => [{ kind: "list-probe", data: {} }]}
      />
    </>
  );
}
