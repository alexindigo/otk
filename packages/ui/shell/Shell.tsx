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
import {
  DEFAULT_PREFS,
  type PromptPart,
  sessionAncestors,
  type ShellLayout,
} from "@otk/protocol";
import {
  type ClientTabs,
  CommandHub,
  createCurrentClient,
  createDrafts,
  createInbox,
  createNavigation,
  createTabs,
  createTaskActions,
  hashFor,
  type InboxModel,
  inboxProjects,
  liveSessionInfo,
  loadHistory,
  LOCAL_SIDECAR,
  projectHash,
  projectName,
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
import RightPanel from "../components/RightPanel.tsx";
import ProjectTabs from "../components/ProjectTabs.tsx";
import { PanelLeftIcon, PanelRightIcon } from "../components/ChromeIcons.tsx";
import { type SessionPorts, SessionProvider } from "../registries/session.tsx";
import { ShellProvider } from "./context.tsx";

/** Reusable application shell; web/src selects modules and the API address. */
export default function Shell(
  props: { theme: ThemeEngine; api: URL },
): import("solid-js").Element {
  const index = createIndex(), inboxes = new Map<string, InboxModel>();
  const tabModels = new Map<string, ClientTabs>();
  const tabInput = (p: ProjectSelection) => ({
    directory: p.directory,
    entries: Object.values(index.state.entries).filter((e) =>
      e.sidecarId === p.sidecarId
    ),
    inbox: inbox(p.sidecarId).state.inbox,
  });
  const tabsFor = (p: ProjectSelection) => {
    const key = `${p.sidecarId}/${p.directory}`;
    let model = tabModels.get(key);
    if (!model) {
      model = createTabs(inbox(p.sidecarId).promote, solidState, {
        input: () => tabInput(p),
        session: (sessionID) =>
          sidecars.connection(p.sidecarId).rpc.call("session.get", {
            sessionID,
          }),
      });
      model.update(tabInput(p));
      tabModels.set(key, model);
    }
    return model;
  };
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
  const drafts = createDrafts(solidState);
  const draftKey = () => {
    const selected = session.state.selection;
    return selected ? sessionKey(selected.sidecarId, selected.sessionID) : "";
  };
  const draft = () => drafts.get(draftKey());
  const current = createCurrentClient(
    () => session.state.selection,
    (id) => sidecars.connection(id),
  );
  const toggles = createToggles((key, value) =>
    sidecars.connection(LOCAL_SIDECAR).rpc.call("prefs.set", { key, value })
  );
  const [settings, setSettings] = createSignal(false),
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
    () =>
      [
        toggles.state.prefs.theme,
        toggles.state.prefs.systemLightTheme,
      ] as const,
    ([id, light]) =>
      props.theme.commit(
        id ?? DEFAULT_PREFS.theme,
        light ?? DEFAULT_PREFS.systemLightTheme,
      ),
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
    const current = drafts.writer(draftKey())((value) => value);
    if (!current.editor && ![...dirty.values()].some(Boolean)) return true;
    if (
      !globalThis.confirm(
        "Discard unsaved editor or attention input before switching sessions?",
      )
    ) return false;
    if (current.editor) {
      drafts.writer(draftKey())((value) => ({ ...value, editor: undefined }));
    }
    return true;
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
    // Navigation owns family identity. Callers may know only an immediate
    // parent; every entry point still writes the same root-based session URL.
    const ancestors = sessionAncestors(
      selection.sessionID,
      (id) => entry(selection.sidecarId, id),
    );
    if (ancestors.length) {
      selection = { ...selection, rootID: ancestors.at(-1) };
    }
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
      return true;
    }
    return false;
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
  const create = async (
    sidecarId: string,
    directory: string,
    task?: import("@otk/protocol").TaskRecord,
  ) => {
    if (!discardDraft()) return;
    const revision = ++navigationRevision;
    try {
      const created = await sidecars.connection(sidecarId).rpc.call(
        "session.create",
        { directory },
      );
      if (task) {
        await sidecars.connection(sidecarId).rpc.call("tasks.sessions", {
          id: task.id,
          sessions: [...task.sessions, created.id],
        });
      }
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
    navigate({
      sidecarId: selected.sidecarId,
      sessionID: id,
      ...(entry(selected.sidecarId, id)
        ? {}
        : { rootID: selected.rootID || selected.sessionID }),
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
          : sidecars.state.list.some((s) =>
            s.id === target.sidecarId && s.capabilities.includes(capability)
          ),
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
  createEffect(() => {
    const p = project();
    if (!p) return undefined;
    const metadata = inbox(p.sidecarId).state.inbox;
    return {
      p,
      entries: entries().filter((e) => e.sidecarId === p.sidecarId).map((
        e,
      ) => ({ ...e, attention: { ...e.attention } })),
      metadata: {
        ...metadata,
        tasks: metadata.tasks.map((t) => ({ ...t, sessions: [...t.sessions] })),
        seen: { ...metadata.seen },
        finishes: { ...metadata.finishes },
      },
      selected: session.state.selection,
    };
  }, (value) => {
    if (!value) return;
    const model = tabsFor(value.p);
    model.update({
      directory: value.p.directory,
      entries: value.entries,
      inbox: value.metadata,
    });
    const id = value.selected?.sessionID;
    if (
      id && value.entries.some((e) =>
        e.id === id && e.directory === value.p.directory
      ) && (model.state.sessionID !== id || !model.state.selected)
    ) {
      model.preview(id);
    }
  });
  // R5's Sessions view calls this port; it never reaches into tab UI internals.
  onCleanup(
    commands.register({
      id: "session.preview",
      title: "Preview session",
      category: "Session",
      hidden: true,
      run: (_ctx, target: Selection) => {
        if (!navigate(target)) return false;
        const directory = entry(target.sidecarId, target.sessionID)?.directory;
        if (directory) {
          tabsFor({ sidecarId: target.sidecarId, directory }).preview(
            target.sessionID,
          );
        }
        return true;
      },
    }),
  );
  onCleanup(commands.register({
    id: "session.pin",
    title: "Open session as task",
    category: "Session",
    hidden: true,
    run: async (_ctx, target: Selection) => {
      if (!navigate(target)) return false;
      const directory = entry(target.sidecarId, target.sessionID)?.directory;
      if (!directory) return false;
      const model = tabsFor({ sidecarId: target.sidecarId, directory });
      model.preview(target.sessionID);
      // A helper already belongs to its ancestor's task. Do not duplicate it.
      if (model.state.selected?.kind === "task") return true;
      await model.pin(target.sessionID);
      return true;
    },
  }));
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
  const originalTitle = document.title;
  createEffect(
    () => [info()?.title, project()] as const,
    ([title, selected]) => {
      document.title = [
        title,
        selected && projectName(selected.directory),
        "OTK",
      ]
        .filter(Boolean).join(" — ");
    },
  );
  onCleanup(() => {
    document.title = originalTitle;
  });
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
  const saveLayout = async (patch: Partial<ShellLayout>) => {
    await sidecars.connection(LOCAL_SIDECAR).rpc.call("layout.patch", patch);
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
          project,
          entries,
          selection: () => session.state.selection,
        }}
      >
        <div
          class="otk-app"
          data-right-collapsed={String(layout().rightCollapsed)}
        >
          <button
            type="button"
            class="otk-icon-button otk-corner otk-corner-left"
            aria-label={layout().leftCollapsed
              ? "Expand projects"
              : "Collapse projects"}
            aria-expanded={layout().leftCollapsed ? "false" : "true"}
            title={layout().leftCollapsed
              ? "Expand projects"
              : "Collapse projects"}
            disabled={!toggles.state.ready}
            onClick={() =>
              void saveLayout({ leftCollapsed: !layout().leftCollapsed }).catch(
                fail,
              )}
          >
            <PanelLeftIcon />
          </button>
          <button
            type="button"
            class="otk-icon-button otk-corner otk-corner-right otk-panel-collapse"
            aria-label={layout().rightCollapsed
              ? "Open right panel"
              : "Collapse right panel"}
            aria-expanded={layout().rightCollapsed ? "false" : "true"}
            title={layout().rightCollapsed
              ? "Open right panel"
              : "Collapse right panel"}
            disabled={!toggles.state.ready}
            onClick={() =>
              void saveLayout({ rightCollapsed: !layout().rightCollapsed })
                .catch(fail)}
          >
            <PanelRightIcon />
          </button>
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
                    <Show when={project()}>
                      <ProjectTabs
                        project={project()!}
                        model={tabsFor(project()!)}
                        entries={entries().filter((e) =>
                          e.sidecarId === project()!.sidecarId &&
                          e.directory === project()!.directory
                        )}
                        inbox={inbox(project()!.sidecarId).state.inbox}
                        messages={session.state.content.messages}
                        exhausted={session.state.exhausted}
                        session={info()}
                        displayMenu={
                          <DisplayMenu
                            prefs={toggles.state.prefs}
                            ready={toggles.state.ready}
                            error={toggles.state.error}
                            onSet={(key, value) =>
                              commands.run("prefs.set", { key, value })}
                          />
                        }
                        ready={sidecars.state.list.find((s) =>
                          s.id === project()!.sidecarId
                        )?.status === "connected"}
                        onOpen={(id) => {
                          return navigate({
                            sidecarId: project()!.sidecarId,
                            sessionID: id,
                          });
                        }}
                        onEmpty={() => navigation.open(projectHash(project()!))}
                        onCreateSession={(task) =>
                          create(
                            project()!.sidecarId,
                            project()!.directory,
                            task,
                          )}
                        actions={createTaskActions(
                          sidecars.connection(project()!.sidecarId).rpc,
                          project()!.directory,
                        )}
                      />
                    </Show>
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
                              ? "Open Sessions in the right panel, or start a new session."
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
                          retryState={session.state.selection
                            ? entry(
                              session.state.selection.sidecarId,
                              session.state.selection.sessionID,
                            )?.retry
                            : undefined}
                          child={!!session.state.selection?.rootID ||
                            !!info()?.parentID}
                          siblings={session.state.siblings}
                          onOpenChild={(id) =>
                            void commands.run("session.child", id)}
                          permissions={session.state.content.permissions}
                          prefs={toggles.state.prefs}
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
                          onDraft={drafts.writer(draftKey())}
                          onPrompt={async (parts, _mode, agent) => {
                            const { selection: target, rpc } = current
                              .context();
                            const directory = await directoryFor(target);
                            await tabsFor({
                              sidecarId: target.sidecarId,
                              directory,
                            }).send(target.sessionID, () =>
                              act(target, async () => {
                                await rpc.call("session.prompt", {
                                  sessionID: target.sessionID,
                                  mode: "normal",
                                  parts: await attachments(
                                    parts,
                                    target.sidecarId,
                                  ),
                                  ...(agent ? { agent } : {}),
                                });
                              }));
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
          <RightPanel
            layout={layout()}
            ready={toggles.state.ready}
            supports={(capability) => {
              const id = project()?.sidecarId;
              const server = sidecars.state.list.find((s) => s.id === id);
              return server?.status === "connected" &&
                server.capabilities.includes(capability);
            }}
            onLayout={saveLayout}
          />
          <Toasts model={notifications.toast} />
          <DialogHost onChange={setDialog} />
        </div>
      </ShellProvider>
    </CommandProvider>
  );
}
