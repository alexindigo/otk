// SPDX-License-Identifier: LGPL-3.0-only
import "./Shell.css" with { type: "text" };
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { DEFAULT_PREFS, type PromptPart } from "@otk/protocol";
import {
  CommandHub,
  createCurrentClient,
  createInbox,
  createNavigation,
  hashFor,
  type InboxModel,
  inboxProjects,
  liveSessionInfo,
  loadHistory,
  LOCAL_SIDECAR,
  projectHash,
  projectRoute,
  type ProjectSelection,
  route,
  type Selection,
  sessionKey,
} from "@otk/client";
import { registerPreferenceCommands } from "@otk/client";
import { registerSessionCommands } from "./commands/sessions.ts";
import { registerAttentionCommands } from "./commands/attention.ts";
import { applicationNotifications } from "./notifications.ts";
import { CommandProvider } from "../keyboard/context.tsx";
import { createIndex } from "../state/index.ts";
import { createSession } from "../state/session.ts";
import { createSidecars } from "../state/sidecars.ts";
import { solidState } from "../state/binding.ts";
import { createKeyboard } from "../keyboard/dispatcher.ts";
import { createToggles } from "../components/Toggles.ts";
import DisplayMenu from "../components/DisplayMenu.tsx";
import { emptyDraft } from "../components/prompt/model.ts";
import Login from "../components/Login.tsx";
import NotificationSettings from "../components/NotificationSettings.tsx";
import { paintVisualPreferences } from "../features/visual.ts";
import { ProjectSettings } from "../features/projects.tsx";
import SessionView from "../components/SessionView.tsx";
import Settings from "../components/Settings.tsx";
import Setup from "../components/Setup.tsx";
import type { ThemeEngine } from "../theme/engine.ts";
import Toasts from "../components/Toasts.tsx";
import VisualSettings from "../components/VisualSettings.tsx";
import DialogHost from "../components/DialogHost.tsx";
import ProjectInbox from "../components/ProjectInbox.tsx";
import ProjectSessions from "../components/ProjectSessions.tsx";
import { type SessionPorts, SessionProvider } from "../registries/session.tsx";
import { ShellProvider } from "./context.tsx";

/** Reusable application shell; web/src selects modules and the API address. */
export default function Shell(
  props: { theme: ThemeEngine; api: URL },
): import("solid-js").Element {
  const index = createIndex(), inboxes = new Map<string, InboxModel>();
  const inbox = (id: string) => {
    let model = inboxes.get(id);
    if (!model) {
      model = createInbox(sidecars.connection(id).rpc, solidState);
      inboxes.set(id, model);
    }
    return model;
  };
  const sidecars: ReturnType<typeof createSidecars> = createSidecars(
    (id, frame) => {
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        if (!index.receive(id, frame)) {
          sidecars.connection(id).send({ t: "resnapshot" });
        } else notifications.receive(id, frame);
      } else notifications.receive(id, frame);
      inbox(id).receive(frame);
      session.receive(id, frame);
      if (id === LOCAL_SIDECAR) toggles.receive(frame);
    },
    { connection: { api: props.api } },
  );
  const entry = (sidecar: string, id: string) =>
    index.state.entries[sessionKey(sidecar, id)];
  const session = createSession((id) => sidecars.connection(id), entry);
  const current = createCurrentClient(
    () => session.state.selection,
    (id) => sidecars.connection(id),
  );
  const toggles = createToggles((key, value) =>
    sidecars.connection(LOCAL_SIDECAR).rpc.call("prefs.set", { key, value })
  );
  const [settings, setSettings] = createSignal(false),
    [draft, setDraft] = createSignal(emptyDraft()),
    [error, setError] = createSignal("");
  const [dialog, setDialog] = createSignal("");
  const [project, setProject] = createSignal<ProjectSelection>();
  const [now, setNow] = createSignal(Date.now());
  const dirty = new Map<string, boolean>();
  let navigationRevision = 0;
  const fail = (error: unknown) => setError((error as Error).message);
  const commands = new CommandHub(
    () => ({
      sidecar: session.state.selection?.sidecarId,
      session: session.state.selection?.sessionID,
      dialog: dialog() || (draft().editor ? "editor" : ""),
      focus: keyboard.focus(),
    }),
    (id) =>
      keyboard.keymap.list().filter((row) => row.command === id).map((row) =>
        row.key
      ),
  );
  const keyboard = createKeyboard(
    commands,
    fail,
    /Mac|iPhone|iPad/.test(navigator.platform),
  );
  const notifications = applicationNotifications({
    commands,
    prefs: () => toggles.state.prefs,
    selection: () => session.state.selection,
    viewing: () => !settings(),
    connection: (id) => sidecars.connection(id),
    entry,
  });
  onCleanup(() => notifications.stop());
  createEffect(
    () => [toggles.state.prefs, session.state.selection, settings()] as const,
    () => notifications.update(),
  );
  createEffect(() => error(), (text) => {
    if (text) notifications.error(new Error(text));
  });
  for (
    const command of [
      {
        id: "palette.open",
        title: "Open command palette",
        category: "Commands",
        dialog: "palette",
      },
      {
        id: "help.keys",
        title: "Keyboard shortcuts",
        category: "Commands",
        dialog: "keys",
      },
      {
        id: "theme.open",
        title: "Choose theme",
        category: "Display",
        dialog: "theme",
        slash: ["theme"],
      },
    ]
  ) {
    onCleanup(commands.register({
      ...command,
      run: () => commands.run("dialog.open", { id: command.dialog }),
    }));
  }
  createEffect(
    () => toggles.state.prefs.theme,
    (id) => props.theme.commit(id ?? DEFAULT_PREFS.theme),
  );
  createEffect(
    () => [
      toggles.state.prefs.reducedColors,
      toggles.state.prefs.animationsOff,
    ],
    () => paintVisualPreferences(toggles.state.prefs),
  );
  createEffect(
    () => toggles.state.prefs.keymap,
    (value) => keyboard.keymap.setKeymap(value ?? {}),
  );
  onCleanup(
    commands.register({
      id: "settings.open",
      title: "Settings",
      category: "Connections",
      run: () => {
        navigationRevision++;
        setSettings(true);
      },
    }),
  );
  onCleanup(
    commands.register({
      id: "settings.close",
      title: "Close settings",
      category: "Connections",
      hidden: true,
      run: () => setSettings(false),
    }),
  );
  onCleanup(
    registerPreferenceCommands(commands, {
      ready: () => toggles.state.ready,
      prefs: () => toggles.state.prefs,
      set: async (key, value) => {
        const permission = key === "notify.os" && value
          ? notifications.os.request()
          : undefined;
        await toggles.set(key, value);
        await permission;
      },
    }),
  );
  const local = createMemo(() =>
    sidecars.state.list.find((s) => s.id === LOCAL_SIDECAR)!
  );
  const selectedSidecar = createMemo(() =>
    sidecars.state.list.find((s) => s.id === session.state.selection?.sidecarId)
  );
  const info = createMemo(() => {
    const selected = session.state.selection;
    return liveSessionInfo(
      session.state.info,
      selected ? entry(selected.sidecarId, selected.sessionID) : undefined,
    );
  });
  const directoryFor = async (target: Selection): Promise<string> => {
    const known = entry(target.sidecarId, target.sessionID);
    if (known) return known.directory;
    const selected = info();
    if (
      selected?.id === target.sessionID &&
      session.state.selection?.sidecarId === target.sidecarId
    ) return selected.directory;
    return (await sidecars.connection(target.sidecarId).rpc.call(
      "session.get",
      { sessionID: target.sessionID },
    )).directory;
  };
  const act = async <T,>(target: Selection, action: () => Promise<T>) => {
    const directory = await directoryFor(target);
    return await inbox(target.sidecarId).act(directory, action);
  };
  onCleanup(registerAttentionCommands(commands, {
    permission: async (input) => {
      const { sidecarId, ...reply } = input;
      const id = sidecarId ?? current.context().selection.sidecarId;
      await act(
        { sidecarId: id, sessionID: reply.sessionID },
        () => sidecars.connection(id).rpc.call("permission.reply", reply),
      );
    },
    question: async (input) => {
      const { selection: target, rpc } = current.context();
      await act(
        target,
        () =>
          input.answers
            ? rpc.call("question.reply", { ...input, answers: input.answers })
            : rpc.call("question.reject", input),
      );
    },
  }));
  const discardDraft = () => {
    // Solid batches rendered reads during input events; guards use the same
    // owner-current update port as Prompt, not the previous painted value.
    const current = setDraft((value) => value);
    return (!current.input && !current.chips.length && !current.editor &&
      ![...dirty.values()].some(Boolean)) ||
      globalThis.confirm("Discard unsent text before switching sessions?");
  };
  const applyRoute = (hash: string) => {
    const target = route(hash),
      projectTarget = projectRoute(hash),
      previous = session.state.selection;
    const changes = target?.sidecarId !== previous?.sidecarId ||
      target?.sessionID !== previous?.sessionID;
    const server = target?.sidecarId ?? projectTarget?.sidecarId;
    if (server && !sidecars.state.list.some((s) => s.id === server)) {
      setError("The URL refers to an unknown server. Add it in Settings.");
      session.open();
      setProject(undefined);
    } else {
      setError("");
      session.open(target);
      setProject(
        projectTarget ??
          (target && entry(target.sidecarId, target.sessionID)
            ? {
              sidecarId: target.sidecarId,
              directory: entry(target.sidecarId, target.sessionID)!.directory,
            }
            : undefined),
      );
      if (projectTarget) {
        void inbox(projectTarget.sidecarId).openProject(projectTarget.directory)
          .catch(fail);
      }
    }
    if (changes) {
      setDraft(emptyDraft());
      dirty.clear();
    }
  };
  const navigation = createNavigation({
    intent: () => {
      navigationRevision++;
    },
    apply: applyRoute,
    accept: (hash) => {
      const target = route(hash), previous = session.state.selection;
      return (target?.sidecarId === previous?.sidecarId &&
        target?.sessionID === previous?.sessionID) || discardDraft();
    },
  });
  const navigate = (selection: Selection) => {
    const previous = session.state.selection;
    if (navigation.open(hashFor(selection))) {
      setSettings(false);
      // An accepted click is a visit even when history keeps the same URL.
      if (
        previous?.sidecarId === selection.sidecarId &&
        previous.sessionID === selection.sessionID && !session.state.loading
      ) {
        void directoryFor(selection).then((directory) =>
          inbox(selection.sidecarId).openSession(selection.sessionID, directory)
        ).catch(fail);
      }
    }
  };
  const openProject = (target: ProjectSelection) => {
    if (
      project()?.sidecarId === target.sidecarId &&
      project()?.directory === target.directory
    ) {
      setSettings(false);
      void inbox(target.sidecarId).openProject(target.directory).catch(fail);
      if (session.state.selection) return;
    }
    const existing = Object.values(index.state.entries).find((entry) =>
      entry.sidecarId === target.sidecarId &&
      entry.directory === target.directory && !entry.parentID
    );
    if (existing) {
      navigate({ sidecarId: target.sidecarId, sessionID: existing.id });
      return;
    }
    if (navigation.open(projectHash(target))) setSettings(false);
  };
  // Navigation marks seen only after content actually reaches the viewed session.
  let viewed = "", viewedFinish = 0;
  createEffect(() => {
    const selected = session.state.selection, data = info();
    return {
      selected,
      directory: data?.directory,
      loading: session.state.loading,
      settings: settings(),
      connected: selectedSidecar()?.status === "connected",
      finish: selected
        ? inbox(selected.sidecarId).state.inbox.finishes[selected.sessionID] ??
          0
        : 0,
    };
  }, (value) => {
    if (
      !value.selected || !value.directory || value.loading || value.settings ||
      !value.connected
    ) {
      if (!value.selected) viewed = "";
      return;
    }
    const target = value.selected,
      key = sessionKey(target.sidecarId, target.sessionID);
    setProject({ sidecarId: target.sidecarId, directory: value.directory });
    if (viewed !== key) {
      viewed = key;
      viewedFinish = value.finish;
      void inbox(target.sidecarId).openSession(
        target.sessionID,
        value.directory,
      ).catch(fail);
    } else if (
      value.finish > viewedFinish && document.hasFocus() &&
      document.visibilityState === "visible"
    ) {
      viewedFinish = value.finish;
      void sidecars.connection(target.sidecarId).rpc.call("sessions.seen", {
        sessionID: target.sessionID,
      }).catch(fail);
    }
  });
  const create = async (sidecarId: string, directory: string) => {
    if (!discardDraft()) return;
    const revision = ++navigationRevision;
    try {
      const created = await sidecars.connection(sidecarId).rpc.call(
        "session.create",
        { directory },
      );
      if (revision === navigationRevision) {
        navigate({ sidecarId, sessionID: created.id });
      }
    } catch (error) {
      if (revision === navigationRevision) fail(error);
    }
  };
  const attachments = (
    parts: PromptPart[],
    sidecarID: string,
  ): Promise<PromptPart[]> =>
    Promise.all(
      parts.map((part) =>
        part.kind === "file" && part.source === "history"
          ? sidecars.connection(part.sidecarID || sidecarID).rpc.call(
            "history.attachment",
            { messageID: part.messageID, partID: part.partID },
          )
          : part
      ),
    );
  const openChild = (id: string) => {
    const selected = session.state.selection!;
    let current = entry(selected.sidecarId, id),
      root = current ? id : selected.rootID || selected.sessionID;
    const seen = new Set<string>();
    while (current?.parentID && !seen.has(current.id)) {
      seen.add(current.id);
      root = current.parentID;
      current = entry(selected.sidecarId, root);
    }
    navigate({
      sidecarId: selected.sidecarId,
      sessionID: id,
      ...(id === root ? {} : { rootID: root }),
    });
  };
  onCleanup(registerSessionCommands(commands, {
    available: (input) =>
      input
        ? sidecars.state.list.find((s) => s.id === input.sidecarId)?.status ===
          "connected"
        : !!project() &&
          sidecars.state.list.find((s) => s.id === project()?.sidecarId)
              ?.status === "connected",
    create: async (input) => {
      const target = input ?? project();
      if (target) await create(target.sidecarId, target.directory);
    },
    open: navigate,
    child: openChild,
    older: () => session.older(),
    retry: () => session.refetch(),
  }));
  const sessionPorts = (): SessionPorts => {
    const target = { ...session.state.selection! },
      connection = sidecars.connection(target.sidecarId);
    return {
      supports: (capability) =>
        capability === "history"
          ? sidecars.state.list.some((s) =>
            s.status === "connected" && s.capabilities.includes(capability)
          )
          : connection.supports(capability),
      rpc: (method, params) => connection.rpc.call(method, params),
      sessionID: () => target.sessionID,
      directory: () => directoryFor(target),
      entry: (id) => entry(target.sidecarId, id),
      permissions: () => session.state.content.permissions,
      questions: () => session.state.content.questions,
      prefs: () => toggles.state.prefs,
      dirty: (owner, value) => {
        dirty.set(owner, value);
      },
      act: (action) => act(target, action),
      history: () =>
        loadHistory(
          sidecars.state.list.filter((s) =>
            s.status === "connected" && s.capabilities.includes("history")
          ).map((s) => ({ id: s.id, connection: sidecars.connection(s.id) })),
        ),
      attachments: (parts) => attachments(parts, target.sidecarId),
    };
  };
  const entries = () => Object.values(index.state.entries);
  const projects = createMemo(() =>
    sidecars.state.list.flatMap((s) =>
      inboxProjects(
        entries().filter((e) => e.sidecarId === s.id),
        inbox(s.id).state.inbox,
        now(),
        toggles.state.prefs.projectAgeing,
      ).map((p) => ({ ...p, sidecarId: s.id, label: s.label }))
    )
  );
  onSettled(() => {
    const stopNotifications = notifications.start(),
      stopKeyboard = keyboard.start();
    const unbindPalette = keyboard.keymap.bind({
      id: "palette.open",
      command: "palette.open",
      key: "Mod+k",
      inPrompt: true,
    });
    const unbindHelp = keyboard.keymap.bind({
      id: "help.keys",
      command: "help.keys",
      key: "?",
    });
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    navigation.start();
    sidecars.start();
    return () => {
      clearInterval(timer);
      stopNotifications();
      stopKeyboard();
      unbindPalette();
      unbindHelp();
      navigation.stop();
      session.stop();
      sidecars.stop();
    };
  });
  const layout = () => toggles.state.prefs.shellLayout;
  const saveLayout = async (value: typeof DEFAULT_PREFS.shellLayout) => {
    await sidecars.connection(LOCAL_SIDECAR).rpc.call("prefs.set", {
      key: "shellLayout",
      value,
    });
  };
  return (
    <CommandProvider commands={commands} keyboard={keyboard}>
      <ShellProvider
        ports={{
          theme: props.theme,
          toggles,
          servers: () => sidecars.state.list,
          connection: (id) => sidecars.connection(id),
          inbox,
          openProject,
        }}
      >
        <div class="otk-app">
          <ProjectInbox
            projects={projects()}
            entries={entries()}
            servers={sidecars.state.list}
            selected={project()}
            prefs={toggles.state.prefs}
            ready={toggles.state.ready}
            onOpen={openProject}
            onInactive={async (p, inactive) => {
              await sidecars.connection(p.sidecarId).rpc.call(
                "projects.inactive",
                { directory: p.directory, inactive },
              );
            }}
            onLayout={saveLayout}
          />
          <main class="otk-main">
            <Show when={error()}>
              <p class="otk-error otk-global-error" role="alert">{error()}</p>
            </Show>
            <div class="otk-shell-toolbar">
              <button
                type="button"
                aria-label={layout().rightCollapsed
                  ? "Open right panel"
                  : "Collapse right panel"}
                disabled={!toggles.state.ready}
                onClick={() =>
                  void saveLayout({
                    ...layout(),
                    rightCollapsed: !layout().rightCollapsed,
                  }).catch(fail)}
              >
                ◫
              </button>
            </div>
            <Show
              when={settings()}
              fallback={
                <Show
                  when={local().status !== "setup required"}
                  fallback={
                    <div class="otk-auth-view">
                      <Setup
                        onSetup={(input) =>
                          sidecars.connection(LOCAL_SIDECAR).setup(input)}
                      />
                    </div>
                  }
                >
                  <Show
                    when={local().status !== "login required"}
                    fallback={
                      <div class="otk-auth-view">
                        <Login
                          label={local().label}
                          authType={local().authType}
                          onLogin={(input) =>
                            sidecars.connection(LOCAL_SIDECAR).login(input)}
                        />
                      </div>
                    }
                  >
                    <ProjectSessions
                      entries={entries()}
                      project={project()}
                      selected={session.state.selection}
                      connected={(id) =>
                        sidecars.state.list.find((s) => s.id === id)?.status ===
                          "connected"}
                      inbox={(id) => inbox(id).state.inbox}
                      onOpen={(e) =>
                        void commands.run("session.open", {
                          sidecarId: e.sidecarId,
                          sessionID: e.id,
                        })}
                      onCreate={(p) => void commands.run("session.new", p)}
                    />
                    <Show
                      when={session.state.selection}
                      keyed
                      fallback={
                        <div class="otk-welcome">
                          <h1>
                            {project()
                              ? "Choose a session"
                              : "Open Terminal Kit"}
                          </h1>
                          <p>
                            {project()
                              ? "Open a session above, or start a new one in this project."
                              : "Choose a project to supervise its sessions."}
                          </p>
                        </div>
                      }
                    >
                      <SessionProvider ports={sessionPorts()}>
                        <SessionView
                          revert={session.state.content.revert}
                          busy={!!session.state.selection &&
                            entry(
                                session.state.selection.sidecarId,
                                session.state.selection.sessionID,
                              )?.status !== "idle"}
                          child={!!session.state.selection?.rootID ||
                            !!info()?.parentID}
                          siblings={session.state.siblings}
                          onOpenChild={(id) =>
                            void commands.run("session.child", id)}
                          permissions={session.state.content.permissions}
                          prefs={toggles.state.prefs}
                          displayMenu={
                            <DisplayMenu
                              prefs={toggles.state.prefs}
                              ready={toggles.state.ready}
                              error={toggles.state.error}
                              onSet={(key, value) =>
                                commands.run("prefs.set", { key, value })}
                            />
                          }
                          info={info()}
                          label={selectedSidecar()?.label || "Server"}
                          messages={session.state.content.messages}
                          loading={session.state.loading}
                          paging={session.state.paging}
                          exhausted={session.state.exhausted}
                          error={session.state.error}
                          sessionError={session.state.content.error}
                          errorState={session.state.content.errorState}
                          draft={draft()}
                          connected={selectedSidecar()?.status === "connected"}
                          onOlder={() => commands.run("session.older")}
                          onRetry={() => commands.run("session.retry")}
                          onDraft={(value) => setDraft(value)}
                          onPrompt={async (parts, _mode, agent) => {
                            const { selection: target, rpc } = current
                              .context();
                            await act(target, async () => {
                              await rpc.call("session.prompt", {
                                sessionID: target.sessionID,
                                mode: "normal",
                                parts: await attachments(
                                  parts,
                                  target.sidecarId,
                                ),
                                ...(agent ? { agent } : {}),
                              });
                            });
                          }}
                          onAbort={async () => {
                            const { selection: target, rpc } = current
                              .context();
                            await act(target, () =>
                              rpc.call("session.abort", {
                                sessionID: target.sessionID,
                              }));
                          }}
                        />
                      </SessionProvider>
                    </Show>
                  </Show>
                </Show>
              }
            >
              <Settings
                appearance={
                  <>
                    <VisualSettings
                      prefs={toggles.state.prefs}
                      ready={toggles.state.ready}
                      onSet={(key, value) =>
                        commands.run("prefs.set", { key, value })}
                    />
                    <ProjectSettings />
                  </>
                }
                notifications={
                  <NotificationSettings
                    prefs={toggles.state.prefs}
                    ready={toggles.state.ready}
                    browser={notifications.os}
                    onSet={(key, value) =>
                      commands.run("prefs.set", { key, value })}
                  />
                }
                sidecars={sidecars.state.list}
                onAdd={async (url, label) => {
                  await sidecars.add(url, label);
                  notifications.info("Server added");
                }}
                onRemove={(id) => {
                  if (project()?.sidecarId === id && !navigation.open("")) {
                    return;
                  }
                  index.remove(id);
                  notifications.remove(id);
                  inboxes.delete(id);
                  sidecars.remove(id);
                }}
                onLogin={(id, input) => sidecars.connection(id).login(input)}
                onSetup={(input) =>
                  sidecars.connection(LOCAL_SIDECAR).setup(input)}
                onClose={() => void commands.run("settings.close")}
              />
            </Show>
          </main>
          <aside
            class="otk-right-panel-slot"
            aria-label="Right panel"
            hidden={layout().rightCollapsed}
          >
            <p class="otk-muted">No panel views selected.</p>
          </aside>
          <Toasts model={notifications.toast} />
          <DialogHost onChange={setDialog} />
        </div>
      </ShellProvider>
    </CommandProvider>
  );
}
