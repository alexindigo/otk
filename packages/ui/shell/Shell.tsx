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
} from "@otk/protocol";
import {
  CommandHub,
  createCurrentClient,
  createDrafts,
  createNavigation,
  createServerResources,
  createSessionSubmission,
  hashFor,
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
import {
  registerSessionCommands,
  registerSessionTargetCommands,
} from "./commands/sessions.ts";
import { registerAttentionCommands } from "./commands/attention.ts";
import { registerApprovalCommands } from "./commands/approvals.ts";
import { applicationNotifications } from "./notifications.ts";
import { permissionNotificationDetail } from "../features/permission-notification.tsx";
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
import ContextMenu from "../components/ContextMenu.tsx";
import type { SessionContextTarget } from "../features/session-context.ts";

/** Reusable application shell; web/src selects modules and the API address. */
export default function Shell(
  props: { theme: ThemeEngine; api: URL },
): import("solid-js").Element {
  const index = createIndex();
  const resources = createServerResources({
    index,
    factory: solidState,
    sidecars: (receive) =>
      createSidecars(receive, { connection: { api: props.api } }),
  });
  const {
    sidecars,
    inbox,
    approvals,
    entry,
    linked,
    attention,
    entries,
    tabs: tabsFor,
  } = resources;
  const session = createSession(
    (id) => sidecars.connection(id),
    entry,
    (target) => {
      const sidecar = sidecars.state.list.find((s) =>
        s.id === target.sidecarId
      );
      return {
        key: sidecar?.connectionVersion,
        connected: sidecar?.status === "connected",
        available: sidecar?.capabilities.includes("models") ?? false,
      };
    },
  );
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
  const toggles = createToggles(resources.setPreference);
  const [settings, setSettings] = createSignal(false),
    [error, setError] = createSignal("");
  const [dialog, setDialog] = createSignal("");
  const [project, setProject] = createSignal<ProjectSelection>();
  const [now, setNow] = createSignal(Date.now());
  const dirty = new Map<string, boolean>();
  let root!: HTMLDivElement;
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
    attention,
  });
  onCleanup(resources.observe({
    frame: (id, frame, accepted) => {
      if (accepted) notifications.receive(id, frame);
    },
    removed: (id) => notifications.remove(id),
  }));
  onCleanup(
    resources.observe({ frame: (id, frame) => session.receive(id, frame) }),
  );
  onCleanup(resources.observe({
    frame: (id, frame) => {
      if (id === LOCAL_SIDECAR) toggles.receive(frame);
    },
  }));
  onCleanup(() => notifications.stop());
  createEffect(
    () =>
      [
        toggles.state.prefs,
        session.state.selection,
        settings(),
        sidecars.state.list.map((
          s,
        ) => [s.id, s.status, s.harness, approvals(s.id).state.snapshot]),
      ] as const,
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
        context: { kind: "app" },
      },
      {
        id: "help.keys",
        title: "Keyboard shortcuts",
        category: "Commands",
        dialog: "keys",
      },
      {
        id: "display.open",
        title: "Display preferences",
        category: "Display",
        dialog: "display",
        context: { kind: "app" },
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
  const local = createMemo(() => resources.server(LOCAL_SIDECAR)!);
  const selectedSidecar = createMemo(() =>
    resources.server(session.state.selection?.sidecarId ?? "")
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
  const submitFor = (target: Selection) =>
    createSessionSubmission({
      sessionID: target.sessionID,
      directory: () => directoryFor(target),
      inbox: inbox(target.sidecarId),
      tabs: (directory) => tabsFor({ sidecarId: target.sidecarId, directory }),
    });
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
  onCleanup(registerApprovalCommands(commands, {
    current: (input) => {
      const target = input ?? session.state.selection;
      if (!target || !approvals(target.sidecarId).canEnable(target.sessionID)) {
        return undefined;
      }
      const server = resources.server(target.sidecarId);
      return {
        model: approvals(target.sidecarId),
        sessionID: target.sessionID,
        connected: server?.status === "connected",
      };
    },
    beforeEnable: (target) =>
      target.model !==
        (session.state.selection &&
          approvals(session.state.selection.sidecarId)) ||
      target.sessionID !== session.state.selection?.sessionID ||
      !dirty.get("permissions") ||
      globalThis.confirm(
        "Discard unsaved permission input before enabling auto-approve for this session and its helpers?",
      ),
  }));
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
    const rpc = sidecars.connection(sidecarId).rpc;
    const actions = resources.taskActions({ sidecarId, directory });
    try {
      const created = await rpc.call(
        "session.create",
        { directory },
      );
      if (task) {
        await actions.add(task, created.id);
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
  const creationTarget = (input?: ProjectSelection) =>
    input ?? session.state.selection ?? project();
  onCleanup(registerSessionCommands(commands, {
    available: (input) => {
      const target = creationTarget(input);
      return !!target &&
        resources.connected(target.sidecarId);
    },
    create: async (input) => {
      const target = creationTarget(input);
      if (!target) return;
      const sidecarId = target.sidecarId, revision = navigationRevision;
      const directory = "directory" in target
        ? target.directory
        : await directoryFor(target);
      if (revision === navigationRevision) await create(sidecarId, directory);
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
          ? resources.anyAdvertised(capability)
          : resources.declares(target.sidecarId, capability),
      rpc: (method, params) => connection.rpc.call(method, params),
      connectionKey: () => resources.connectionKey(target.sidecarId),
      connected: () => linked(target.sidecarId),
      onToolCompleted: (listener) => session.onToolCompleted(target, listener),
      modelCatalog: session.models,
      approvals: approvals(target.sidecarId),
      sessionID: () => target.sessionID,
      directory: () => directoryFor(target),
      entry: (id) => entry(target.sidecarId, id),
      location: (id) => {
        const value = entry(target.sidecarId, id),
          tasks = inbox(target.sidecarId).state.inbox.tasks;
        const task = tasks.find((task) =>
          task.sessions.includes(id) ||
          task.sessions.includes(target.rootID ?? target.sessionID)
        );
        return [
          value && projectName(value.directory),
          task?.name ?? value?.title,
        ].filter(Boolean).join(", ");
      },
      permissions: () => session.state.content.permissions,
      questions: () => session.state.content.questions,
      prefs: () => toggles.state.prefs,
      dirty: (owner, value) => {
        dirty.set(owner, value);
      },
      act: (action) => act(target, action),
      submit: submitFor(target),
      history: () => loadHistory(resources.historySources()),
      attachments: (parts) => attachments(parts, target.sidecarId),
    };
  };
  createEffect(() => {
    const p = project();
    if (!p) return undefined;
    return {
      p,
      input: resources.tabSnapshot(p),
      selected: session.state.selection,
    };
  }, (value) => {
    if (!value) return;
    resources.syncTabs(value.p, value.input, value.selected);
  });
  // Session targets share one transition-aware command owner across all views.
  onCleanup(registerSessionTargetCommands(commands, {
    current: () => session.state.selection,
    exists: (target) => !!entry(target.sidecarId, target.sessionID),
    connected: (target) => resources.connected(target.sidecarId),
    inTask: (target) => {
      const value = entry(target.sidecarId, target.sessionID);
      const family = [
        target.sessionID,
        ...sessionAncestors(
          target.sessionID,
          (id) => entry(target.sidecarId, id),
        ),
      ];
      return inbox(target.sidecarId).state.inbox.tasks.some((task) =>
        task.directory === value?.directory &&
        task.sessions.some((id) => family.includes(id))
      );
    },
    open: (target) => {
      if (!navigate(target)) return false;
      const directory = entry(target.sidecarId, target.sessionID)?.directory;
      if (directory) {
        tabsFor({ sidecarId: target.sidecarId, directory }).preview(
          target.sessionID,
        );
      }
      return true;
    },
    pin: async (target) => {
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
  onCleanup(commands.register({
    id: "session.title.copy",
    title: "Copy session title",
    category: "Session",
    hidden: true,
    context: { kind: "session", order: 40 },
    enabled: (_ctx, target?: SessionContextTarget) => !!target,
    run: (_ctx, target: SessionContextTarget) =>
      navigator.clipboard.writeText(target.title),
  }));
  const projects = createMemo(() =>
    resources.projects(now(), toggles.state.prefs.projectAgeing)
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
    const unbindAuto = keyboard.keymap.bind({
      id: "permission.auto",
      command: "permission.auto",
      key: "Mod+Shift+a",
      inPrompt: true,
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
      unbindAuto();
      navigation.stop();
      session.stop();
      resources.stop();
    };
  });
  const layout = () => toggles.state.prefs.shellLayout;
  const saveLayout = resources.layout;
  for (const side of ["projects", "panel"] as const) {
    const collapsed = () =>
      side === "projects" ? layout().leftCollapsed : layout().rightCollapsed;
    const title = () =>
      side === "projects"
        ? (collapsed() ? "Expand projects" : "Collapse projects")
        : (collapsed() ? "Open right panel" : "Collapse right panel");
    onCleanup(commands.register({
      id: `layout.${side}.toggle`,
      title: title(),
      category: "Layout",
      context: { kind: side, title, order: 100 },
      enabled: () => toggles.state.ready,
      run: () =>
        saveLayout(
          side === "projects"
            ? { leftCollapsed: !collapsed() }
            : { rightCollapsed: !collapsed() },
        ),
    }));
  }
  return (
    <CommandProvider commands={commands} keyboard={keyboard}>
      <ShellProvider
        ports={{
          theme: props.theme,
          toggles,
          usage: session.usage,
          servers: () => sidecars.state.list,
          connection: (id) => sidecars.connection(id),
          inbox,
          approvals,
          openProject,
          project,
          entries,
          selection: () => session.state.selection,
        }}
      >
        <div
          class="otk-app"
          ref={(element) => {
            root = element;
          }}
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
              void commands.run("layout.projects.toggle").catch(fail)}
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
            onClick={() => void commands.run("layout.panel.toggle").catch(fail)}
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
            onInactive={resources.inactive}
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
                        entries={resources.projectEntries(project()!)}
                        inbox={inbox(project()!.sidecarId).state.inbox}
                        messages={session.state.content.messages}
                        usage={session.state.selection
                          ? session.usage.get(session.state.selection)?.total
                          : undefined}
                        catalog={session.models?.state.available
                          ? session.models.state.value
                          : undefined}
                        exhausted={session.state.exhausted}
                        showCost={toggles.state.prefs.showCost}
                        auto={(id) =>
                          !!approvals(project()!.sidecarId).owner(id)}
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
                        ready={resources.connected(project()!.sidecarId)}
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
                        actions={resources.taskActions(project()!)}
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
                          sidecarId={session.state.selection?.sidecarId}
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
                          usage={session.state.selection
                            ? session.usage.get(session.state.selection)
                            : undefined}
                          catalog={session.models?.state.available
                            ? session.models.state.value
                            : undefined}
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
                          onPrompt={async (parts, _mode, selection) => {
                            const { selection: target, rpc } = current
                              .context();
                            await submitFor(target)(async () => {
                              await rpc.call("session.prompt", {
                                sessionID: target.sessionID,
                                mode: "normal",
                                parts: await attachments(
                                  parts,
                                  target.sidecarId,
                                ),
                                ...selection,
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
                  await resources.add(url, label);
                  notifications.info("Server added");
                }}
                onRemove={(id) => {
                  if (project()?.sidecarId === id && !navigation.open("")) {
                    return;
                  }
                  resources.remove(id);
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
            supports={(capability) =>
              resources.advertised(project()?.sidecarId ?? "", capability)}
            onLayout={saveLayout}
          />
          <Toasts
            model={notifications.toast}
            detail={permissionNotificationDetail}
          />
          <DialogHost onChange={setDialog} />
          <ContextMenu root={root} />
        </div>
      </ShellProvider>
    </CommandProvider>
  );
}
