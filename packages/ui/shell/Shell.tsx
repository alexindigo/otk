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
import { DEFAULT_PREFS } from "@otk/protocol";
import { CommandHub, LOCAL_SIDECAR, shellTitle } from "@otk/client";
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
import { createShellState } from "../state/shell.ts";
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
import { SessionProvider } from "../registries/session.tsx";
import { sessionPorts } from "./session-ports.ts";
import { ShellProvider } from "./context.tsx";
import ContextMenu from "../components/ContextMenu.tsx";
import type { SessionContextTarget } from "../features/session-context.ts";

/** Reusable application shell; web/src selects modules and the API address. */
export default function Shell(
  props: { theme: ThemeEngine; api: URL },
): import("solid-js").Element {
  const { resources, session, drafts, actions, guard, navigation } =
    createShellState({ api: props.api });
  const {
    sidecars,
    inbox,
    approvals,
    entry,
    attention,
    entries,
    tabs: tabsFor,
  } = resources;
  const draftKey = actions.key;
  const draft = () => drafts.get(draftKey());
  const toggles = createToggles(resources.setPreference);
  const settings = () => navigation.state.settings;
  const error = () => navigation.state.error;
  const project = () => navigation.state.project;
  const { fail, navigate, openProject } = navigation;
  const [dialog, setDialog] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  let root!: HTMLDivElement;
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
    resources.observe({
      frame: (id, frame) => session.receive(id, frame),
      removed: (id) => session.usage.removeServer(id),
    }),
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
      run: navigation.showSettings,
    }),
  );
  onCleanup(
    commands.register({
      id: "settings.close",
      title: "Close settings",
      category: "Connections",
      hidden: true,
      run: navigation.closeSettings,
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
  const info = createMemo(actions.info);
  onCleanup(registerAttentionCommands(commands, actions));
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
      guard.permit(
        "permissions",
        "Discard unsaved permission input before enabling auto-approve for this session and its helpers?",
      ),
  }));
  onCleanup(registerSessionCommands(commands, {
    available: navigation.available,
    create: navigation.create,
    open: navigate,
    child: navigation.openChild,
    older: () => session.older(),
    retry: () => session.refetch(),
  }));
  // Session targets share one transition-aware command owner across all views.
  onCleanup(registerSessionTargetCommands(commands, {
    current: () => session.state.selection,
    exists: (target) => !!entry(target.sidecarId, target.sessionID),
    connected: (target) => resources.connected(target.sidecarId),
    inTask: actions.inTask,
    open: navigation.preview,
    pin: navigation.pin,
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
      document.title = shellTitle(title, selected);
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
                        reserveTrailing={layout().rightCollapsed}
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
                        onEmpty={navigation.projectHome}
                        onCreateSession={(task) =>
                          navigation.createIn(
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
                      <SessionProvider
                        ports={sessionPorts({
                          target: session.state.selection!,
                          resources,
                          actions,
                          session,
                          guard,
                          prefs: () => toggles.state.prefs,
                        })}
                      >
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
                          onPrompt={(parts, _mode, selection) =>
                            actions.prompt(parts, selection)}
                          onAbort={actions.abort}
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
                onAdd={(url, label) => resources.add(url, label).then(() => {
                  notifications.info("Server added");
                })}
                onRemove={(id) => navigation.removeServer(id)}
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
