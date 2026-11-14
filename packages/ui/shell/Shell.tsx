// SPDX-License-Identifier: LGPL-3.0-only
import { errorFeedback } from "@otk/client";
import FeedbackStatus from "../components/FeedbackStatus.tsx";
import PaneState from "../components/PaneState.tsx";
import GlobalSurfaces from "../components/GlobalSurfaces.tsx";
import ProgressStatus from "../components/ProgressStatus.tsx";
import "./Shell.css" with { type: "text" };
import { scrollRegion } from "../components/ScrollRegion.tsx";
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
import { registerSessionActionCommands } from "./commands/session-actions.ts";
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
import TranscriptSettings from "../components/TranscriptSettings.tsx";
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
import DeletedSession from "../components/DeletedSession.tsx";
import { deletedFacts } from "@otk/client";
import { contextTarget } from "../components/context-target.ts";
import { AttentionProvider } from "../registries/attention.tsx";
import { attentionPresentation } from "../state/attention-grace.ts";

/** Reusable application shell; web/src selects modules and the API address. */
export default function Shell(
  props: { theme: ThemeEngine; api: URL },
): import("solid-js").Element {
  const {
    resources,
    session,
    drafts,
    actions,
    rename,
    revert,
    forkNotes,
    guard,
    navigation,
    listInteraction,
    interact,
    confirmCommand,
  } = createShellState({ api: props.api });
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
  const attentionPaint = attentionPresentation(
    resources,
    () => toggles.state.prefs.animationsOff,
  );
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
    confirmCommand,
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
    observeEntries: resources.observeEntries,
  });
  onCleanup(resources.observe({
    frame: (id, frame, accepted) => {
      if (accepted) notifications.receive(id, frame);
    },
    removed: (id) => notifications.remove(id),
  }));
  onCleanup(
    resources.observe({
      frame: (id, frame, accepted) => {
        if (accepted) session.receive(id, frame);
      },
      removed: session.removeServer,
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
    if (text) notifications.error(text);
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
        name: "theme",
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
  onCleanup(registerSessionActionCommands(commands, {
    archiveAvailable: (target) =>
      actions.eligibility(target).live &&
      resources.connected(target.sidecarId) &&
      resources.advertised(target.sidecarId, "sessionArchive"),
    archived: (target) =>
      resources.entry(target.sidecarId, target.sessionID)?.archived ??
        (session.state.selection?.sidecarId === target.sidecarId &&
            info()?.id === target.sessionID
          ? info()?.archived
          : undefined),
    archive: actions.archive,
    available: (target) =>
      actions.eligibility(target).live &&
      resources.connected(target.sidecarId) &&
      resources.advertised(target.sidecarId, "sessionActions"),
    rename,
    working: actions.working,
    helpers: (target) => Math.max(0, actions.familyEntries(target).length - 1),
    remove: navigation.remove,
    current: () => {
      const target = session.state.selection, value = info();
      return target && value
        ? { ...target, title: value.title, directory: value.directory }
        : undefined;
    },
    fork: navigation.fork,
    revert,
    rolledBack: () => !!session.state.content.revert,
    revertAvailable: (target, capability, interrupt = false) =>
      revert.matches(target) && !target.rootID && !info()?.parentID &&
      resources.connected(target.sidecarId) &&
      resources.advertised(target.sidecarId, capability) &&
      (!actions.working(target) ||
        (interrupt && resources.advertised(target.sidecarId, "prompt"))) &&
      !revert.state.pending,
  }));
  onCleanup(registerAttentionCommands(commands, actions));
  onCleanup(registerApprovalCommands(commands, {
    current: (input) => {
      const target = input ?? session.state.selection;
      if (
        !target || !actions.eligibility(target).live ||
        !approvals(target.sidecarId).canEnable(target.sessionID)
      ) {
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
    eligible: actions.eligibility,
    inTask: actions.inTask,
    open: navigation.preview,
    pin: navigation.pin,
    close: navigation.close,
  }));
  onCleanup(commands.register({
    id: "session.title.copy",
    title: "Copy session title",
    category: "Session",
    arguments: { type: "object", properties: { title: { type: "string" } } },
    context: {
      kind: "session",
      order: 40,
      title: (target: SessionContextTarget) =>
        actions.eligibility(target).live ? "Copy session title" : "Copy title",
    },
    enabled: (_ctx, target?: SessionContextTarget) => !!target,
    run: (_ctx, target: SessionContextTarget) =>
      navigator.clipboard.writeText(target.title),
  }));
  onCleanup(commands.register({
    id: "session.task.remove",
    title: "Remove from task",
    category: "Session",
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        sessionID: { type: "string" },
      },
    },
    context: { kind: "session", order: 45 },
    enabled: (_ctx, target?: SessionContextTarget) =>
      !!target && !actions.eligibility(target).live &&
      actions.eligibility(target).member,
    run: (_ctx, target: SessionContextTarget) => actions.removeFromTask(target),
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
      revert.dispose();
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
    <AttentionProvider ports={attentionPaint}>
      <CommandProvider
        commands={commands}
        keyboard={keyboard}
        failureOwned={resources.ownsFailure}
      >
        <ShellProvider
          ports={{
            theme: props.theme,
            toggles,
            usage: session.usage,
            rename,
            transcript: {
              messages: () => session.state.content.messages,
              exhausted: () => session.state.exhausted,
              paging: () => session.state.paging || session.state.loading,
              older: () => session.older(),
            },
            servers: () => sidecars.state.list,
            forms: resources.forms,
            connection: (id) => sidecars.connection(id),
            inbox,
            approvals,
            openProject,
            project,
            entries,
            entry,
            projectEntries: resources.projectEntries,
            projectMetadata: resources.projectMetadata,
            metadataEntry: resources.metadataEntry,
            sessionRows: resources.sessionRows,
            sessionRowsReady: resources.sessionRowsReady,
            sessionRowsLoading: resources.sessionRowsLoading,
            sessionRowsStatus: resources.sessionRowsStatus,
            visibleRows: resources.visibleRows,
            projectProgress: resources.projectProgress,
            listInteraction,
            selection: () => session.state.selection,
          }}
        >
          <div
            class="otk-app"
            ref={(element) => {
              root = element;
            }}
            onInput={(event) => {
              if (event.isTrusted && !settings()) interact();
            }}
            onWheel={(event) => {
              if (event.isTrusted && !settings()) interact();
            }}
            onClick={(event) => {
              if (event.isTrusted && !settings()) interact();
            }}
            onKeyDown={(event) => {
              if (event.isTrusted && !settings()) interact();
            }}
            data-right-collapsed={String(layout().rightCollapsed)}
          >
            <Show when={toggles.state.ready}>
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
                onClick={() =>
                  void commands.run("layout.panel.toggle").catch(fail)}
              >
                <PanelRightIcon />
              </button>
            </Show>
            <ProjectInbox
              projects={projects()}
              duplicateName={resources.duplicateProjectName}
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
                <FeedbackStatus
                  class="otk-global-error"
                  feedback={errorFeedback(error())}
                />
              </Show>
              <Show
                when={settings()}
                fallback={
                  <Show
                    when={local().status !== "setup required"}
                    fallback={
                      <div class={[scrollRegion(), "otk-auth-view"]}>
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
                        <div class={[scrollRegion(), "otk-auth-view"]}>
                          <Login
                            label={local().label}
                            authType={local().authType}
                            onLogin={(input) =>
                              sidecars.connection(LOCAL_SIDECAR).login(input)}
                          />
                        </div>
                      }
                    >
                      <Show when={project()} keyed>
                        {(owner) => (
                          <>
                            <ProjectTabs
                              reserveTrailing={layout().rightCollapsed}
                              project={owner}
                              model={tabsFor(owner)}
                              currentEntry={(id) =>
                                resources.entry(owner.sidecarId, id)}
                              inbox={inbox(owner.sidecarId).state.inbox}
                              entry={actions.selectedEntry()}
                              eligible={(target) =>
                                actions.eligibility(target).live}
                              catalog={session.models?.state.available
                                ? session.models.state.value
                                : undefined}
                              showCost={toggles.state.prefs.showCost}
                              session={info()}
                              rename={rename}
                              displayMenu={
                                <DisplayMenu
                                  prefs={toggles.state.prefs}
                                  ready={toggles.state.ready}
                                  error={toggles.state.error}
                                  onSet={(key, value) =>
                                    commands.run("prefs.set", { key, value })}
                                />
                              }
                              ready={resources.connected(owner.sidecarId)}
                              onOpen={(id) => {
                                return navigate({
                                  sidecarId: owner.sidecarId,
                                  sessionID: id,
                                });
                              }}
                              onEmpty={navigation.projectHome}
                              onCreateSession={(task) =>
                                navigation.createIn(
                                  owner.sidecarId,
                                  owner.directory,
                                  task,
                                )}
                              actions={resources.taskActions(owner)}
                            />
                            <ProgressStatus
                              class="otk-shell-progress"
                              text={session.transcript?.state.load?.state ===
                                    "loading" &&
                                  !session.state.loading &&
                                  session.transcript.progress?.().busy
                                ? session.transcript.progress().text
                                : resources.progress(owner.sidecarId).busy
                                ? resources.progress(owner.sidecarId).text
                                : ""}
                            />
                          </>
                        )}
                      </Show>
                      <Show
                        when={session.state.selection}
                        keyed
                        fallback={
                          <div class="otk-welcome">
                            <PaneState>
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
                            </PaneState>
                          </div>
                        }
                      >
                        <Show
                          when={session.state.view !== "deleted" &&
                            session.state.catalogReady !== false}
                          fallback={
                            <Show when={session.state.deleted}>
                              {(entry) => (
                                <DeletedSession
                                  title={entry().title}
                                  ref={contextTarget(() => ({
                                    kind: "session",
                                    area: true,
                                    data: {
                                      ...session.state.selection!,
                                      title: entry().title,
                                      directory: entry().directory,
                                    },
                                  }))}
                                  notice={`${
                                    entry().deleted?.how === "otk"
                                      ? "Deleted through OTK"
                                      : "Deleted from the agent service"
                                  } on ${
                                    new Date(entry().deleted!.at)
                                      .toLocaleString()
                                  }`}
                                  facts={deletedFacts(
                                    entry(),
                                    toggles.state.prefs.showCost,
                                    (time) => new Date(time).toLocaleString(),
                                  )}
                                  retained={guard.retained()}
                                  draftNotice={draft().input ||
                                      draft().chips.length || draft().editor
                                    ? "Your unsent draft is retained. This session can no longer receive messages."
                                    : undefined}
                                  copy={() =>
                                    void commands.run("session.title.copy", {
                                      ...session.state.selection!,
                                      title: entry().title,
                                      directory: entry().directory,
                                    }).catch(fail)}
                                  remove={actions.eligibility(
                                      session.state.selection!,
                                    ).member
                                    ? () =>
                                      void commands.run(
                                        "session.task.remove",
                                        session.state.selection,
                                      ).catch(fail)
                                    : undefined}
                                  close={() =>
                                    void commands.run("session.close").catch(
                                      fail,
                                    )}
                                />
                              )}
                            </Show>
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
                              permissionVisible: attentionPaint.permission,
                            })}
                          >
                            <SessionView
                              sidecarId={session.state.selection?.sidecarId}
                              revert={session.state.content.revert}
                              rollback={revert}
                              strip={revert.strip(session.state.content)}
                              busy={!!session.state.selection &&
                                ["busy", "retry"].includes(
                                  entry(
                                    session.state.selection.sidecarId,
                                    session.state.selection.sessionID,
                                  )?.status ?? "",
                                )}
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
                              transcript={session.transcript}
                              latestPrompt={session.state.latestPrompt}
                              continuity={session.state.continuity}
                              usageOwner={session.usage}
                              entry={actions.selectedEntry()}
                              openUsage={resources.declares(
                                  session.state.selection!.sidecarId,
                                  "usage",
                                ) &&
                                  actions.eligibility(session.state.selection!)
                                    .live
                                ? (turnID) => {
                                  const target = {
                                    ...session.state.selection!,
                                    turnID,
                                  };
                                  const release = session.usage.retain(target);
                                  void session.usage.load(target);
                                  return release;
                                }
                                : undefined}
                              usageError={(turnID) =>
                                session.usage.error({
                                  ...session.state.selection!,
                                  turnID,
                                })}
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
                              forkNote={forkNotes.get(draftKey())}
                              onDismissForkNote={() =>
                                forkNotes.dismiss(draftKey())}
                              connected={selectedSidecar()?.status ===
                                "connected"}
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
                  transcript={
                    <TranscriptSettings
                      prefs={toggles.state.prefs}
                      ready={toggles.state.ready}
                      onSet={(key, value) =>
                        commands.run("prefs.set", { key, value })}
                    />
                  }
                  sidecars={sidecars.state.list}
                  discovery={sidecars.state.discovery}
                  onCancelAdd={sidecars.cancelAdd}
                  onAdd={(url, label) =>
                    resources.add(url, label).then(() => {
                      notifications.info("Server added");
                    })}
                  onRemove={(id) => navigation.removeServer(id)}
                  onLogin={(id, input) => sidecars.connection(id).login(input)}
                  onSetup={(input) =>
                    sidecars.connection(LOCAL_SIDECAR).setup(input)}
                  onClose={() => void commands.run("settings.close")}
                />
              </Show>
              <GlobalSurfaces />
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
              onMore={() =>
                void saveLayout({
                  rightCollapsed: false,
                  rightView: "sessions",
                })
                  .catch(fail)}
            />
            <DialogHost onChange={setDialog} />
            <ContextMenu root={root} />
          </div>
        </ShellProvider>
      </CommandProvider>
    </AttentionProvider>
  );
}
