// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled } from "solid-js";
import { createSessionRename, createTabs, type MergedEntry } from "@otk/client";
import type { ContentSession, InboxSnapshot } from "@otk/protocol";
import ProjectTabs from "../../components/ProjectTabs.tsx";
import CommandMenu from "../../components/CommandMenu.tsx";
import Subagents from "../../components/Subagents.tsx";
import { useCommandPorts } from "../../keyboard/context.tsx";
import { solidState } from "../../state/binding.ts";

export default function Scene() {
  const tabs = createTabs(
    () => Promise.reject(new Error("No promotion expected")),
    solidState,
  );
  const rename = createSessionRename({
    rename: () => Promise.resolve(),
    factory: solidState,
  });
  const [directory, setDirectory] = createSignal("/project"),
    [entries, setEntries] = createSignal<MergedEntry[]>([]),
    [session, setSession] = createSignal<ContentSession>(),
    [inbox, setInbox] = createSignal<InboxSnapshot>(localTask([]));
  function localTask(ids: string[]): InboxSnapshot {
    return {
      projects: [],
      tasks: [{
        id: "task",
        directory: "/project",
        name: "Task",
        sessions: ids,
        order: 0,
      }],
      seen: {},
      finishes: {},
      pathTemplates: [],
    };
  }
  const entry = (id: string, index: number, ids: string[]): MergedEntry => ({
    id,
    parentID: index ? ids[index - 1] : undefined,
    sidecarId: "local",
    directory: "/project",
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
  let createdSessions = 0;
  styleTest.createdSessions = () => createdSessions;
  styleTest.lists = (ids, selected = ids[0], editing, publication) => {
    const snapshot = publication?.inbox ?? localTask(ids);
    const task = snapshot.tasks[0];
    const rows = publication
      ? publication.entries.map((row) => ({ ...row, sidecarId: "local" }))
      : ids.map(entry);
    setDirectory(task.directory);
    setEntries(rows);
    setInbox(snapshot);
    tabs.update({
      directory: task.directory,
      entries: rows,
      inbox: snapshot,
    });
    tabs.select({ kind: "task", id: task.id }, selected);
    setSession(
      selected
        ? {
          id: selected,
          directory: task.directory,
          projectID: "p",
          title: rows.find((row) => row.id === selected)?.title ?? selected,
          time: { created: 1, updated: 1 },
          archived: false,
        }
        : undefined,
    );
    if (editing) {
      rename.start(
        {
          sidecarId: "local",
          sessionID: editing,
          title: rows.find((row) => row.id === editing)?.title ?? editing,
        },
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
  let home!: HTMLDivElement;
  return (
    <>
      <ProjectTabs
        project={{ sidecarId: "local", directory: directory() }}
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
      <div tabindex={-1} ref={(region) => home = region}>
        <Subagents
          focusHome={() => home.focus()}
          entities={tabs.entities()}
          helpers={(() => {
            void tabs.state.revision;
            const store = tabs.entities(), key = tabs.trail().task;
            return key && !store.isStale ? store.get(key)?.helpers : undefined;
          })()}
          current={session()?.id ?? ""}
          title={(id) => entries().find((row) => row.id === id)?.title ?? id}
          agent={() => undefined}
          openAction={(id) =>
            commands.control("list.open-helper", undefined, {
              target: { label: id },
              shown: () => true,
              unshown: "The subagent did not open.",
              recovery: "Choose the subagent again",
            })}
        />
      </div>
      <CommandMenu
        label="Reactive list menu"
        trigger="Actions"
        targets={() => [{ kind: "list-probe", data: {} }]}
      />
    </>
  );
}
