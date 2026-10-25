// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled } from "solid-js";
import { createSessionRename, createTabs } from "@otk/client";
import type { ContentSession, InboxSnapshot } from "@otk/protocol";
import ProjectTabs from "../../components/ProjectTabs.tsx";
import CommandMenu from "../../components/CommandMenu.tsx";
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
  const inbox = (): InboxSnapshot => ({
    projects: [],
    tasks: [{
      id: "task",
      directory,
      name: "Task",
      sessions: members(),
      order: 0,
    }],
    seen: {},
    finishes: {},
    pathTemplates: [],
  });
  const entry = (id: string) => ({
    id,
    sidecarId: "local",
    directory,
    projectID: "p",
    title: id,
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "idle" as const,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  });
  const entries = () => members().map(entry);
  styleTest.lists = (ids, selected = ids[0], editing) => {
    setMembers(ids);
    tabs.update({
      directory,
      entries: ids.map(entry),
      inbox: {
        ...inbox(),
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
  onSettled(() => {
    const releases = ["one", "two", "delete"].map((id) =>
      commands.register({
        id: `list.${id}`,
        title: id,
        category: "Probe",
        hidden: true,
        context: { kind: "list-probe", destructive: id === "delete" },
        enabled: () => keys().includes(id),
        run: () => {},
      })
    );
    return () => releases.forEach((release) => release());
  });
  return (
    <>
      <ProjectTabs
        project={{ sidecarId: "local", directory }}
        model={tabs}
        entries={entries()}
        inbox={inbox()}
        messages={[]}
        exhausted
        ready
        session={session()}
        rename={rename}
        onOpen={() => true}
        onEmpty={() => true}
        onCreateSession={() => Promise.resolve()}
        actions={{
          create: () => Promise.reject(new Error("unused")),
          rename: () => Promise.resolve(),
          close: () => Promise.resolve(),
          reorder: () => Promise.resolve(),
          add: () => Promise.resolve(),
          remove: () => Promise.resolve(),
        }}
      />
      <CommandMenu
        label="Reactive list menu"
        trigger="Actions"
        targets={() => [{ kind: "list-probe", data: {} }]}
      />
    </>
  );
}
