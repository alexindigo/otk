// SPDX-License-Identifier: LGPL-3.0-only
import { bindSourceSelectionCopy, copyText } from "../clipboard.ts";
import {
  attentionCount,
  createModelRecency,
  requireCommittedSend,
} from "@otk/client";
import PaneState from "../components/PaneState.tsx";
import GlobalSurfaces from "../components/GlobalSurfaces.tsx";
import ProgressStatus from "../components/ProgressStatus.tsx";
import { clockTitle } from "../components/Clock.tsx";
import "./Shell.css" with { type: "text" };
import ChromeMeta from "../components/ChromeMeta.tsx";
import ScrollRegion from "../components/ScrollRegion.tsx";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { Portal } from "@solidjs/web";
import { DEFAULT_PREFS } from "@otk/protocol";
import {
  canRenameProject,
  CommandHub,
  FeedbackFailure,
  historyTarget,
  LOCAL_SIDECAR,
  shellTitle,
} from "@otk/client";
import {
  registerPreferenceCommands,
  terminalRunFailureOwned,
} from "@otk/client";
import {
  registerSessionCommands,
  registerSessionTargetCommands,
} from "./commands/sessions.ts";
import { registerAttentionCommands } from "./commands/attention.ts";
import { registerApprovalCommands } from "./commands/approvals.ts";
import { registerSessionActionCommands } from "./commands/session-actions.ts";
import { registerCodeBlockCommands } from "../features/code-blocks.tsx";
import { registerFileCommands } from "../features/file-paths.tsx";
import { registerWorkCommands } from "../features/work.tsx";
import { applicationNotifications } from "./notifications.ts";
import { registerServerCommands } from "./commands/server.ts";
import { permissionNotificationDetail } from "../features/permission-notification.tsx";
import { CommandProvider } from "../keyboard/context.tsx";
import { createShellState } from "../state/shell.ts";
import { createKeyboard } from "../keyboard/dispatcher.ts";
import DisplayMenu from "../components/DisplayMenu.tsx";
import Login from "../components/Login.tsx";
import NotificationSettings from "../components/NotificationSettings.tsx";
import { paintVisualPreferences } from "../features/visual.ts";
import { ProjectSettings } from "../features/projects.tsx";
import SessionView, { transcriptStatus } from "../components/SessionView.tsx";
import Settings from "../components/Settings.tsx";
import Setup from "../components/Setup.tsx";
import type { ThemeEngine } from "../theme/engine.ts";
import Toasts from "../components/Toasts.tsx";
import VisualSettings from "../components/VisualSettings.tsx";
import TranscriptSettings from "../components/TranscriptSettings.tsx";
import DialogHost from "../components/DialogHost.tsx";
import ProjectInbox from "../components/ProjectInbox.tsx";
import HistoryButtons from "../components/HistoryButtons.tsx";
import RightPanel from "../components/RightPanel.tsx";
import ProjectTabs from "../components/ProjectTabs.tsx";
import ProjectLocation from "../features/project-chip.tsx";
import { PanelLeftIcon, PanelRightIcon } from "../components/ChromeIcons.tsx";
import { SessionProvider } from "../registries/session.tsx";
import { useUiRegistries } from "../registries/context.tsx";
import { sessionPorts } from "./session-ports.ts";
import { ShellProvider } from "./context.tsx";
import ContextMenu from "../components/ContextMenu.tsx";
import type { SessionContextTarget } from "../features/session-context.ts";
import DeletedSession from "../components/DeletedSession.tsx";
import { deletedFacts, sessionEvidence, sessionRunning } from "@otk/client";
import { entityKey } from "@otk/protocol";
import { contextTarget } from "../components/context-target.ts";
import { insertChip } from "../components/prompt/model.ts";
import { createTerminalConnectionOwner } from "../terminal/connections.ts";

/** Reusable application shell; web/src selects modules and the API address. */
export default function Shell(
  props: {
    theme: ThemeEngine;
    api: URL;
    policy?: import("@otk/protocol").ClientRequestPolicy;
    build?: string;
  },
): import("solid-js").Element {
  const { parts, panels } = useUiRegistries();
  const {
    reload,
    resources,
    session,
    drafts,
    branchHistory,
    actions,
    rename,
    projectRename,
    revert,
    forkNotes,
    guard,
    navigation,
    listInteraction,
    disclosures,
    work,
    toggles,
    interact,
    confirmCommand,
  } = createShellState({
    api: props.api,
    parts,
    policy: props.policy,
    build: props.build,
    promptCommitted: (message) => recentModel(message),
  });
  const {
    sidecars,
    inbox,
    approvals,
    entry,
    entries,
    tabs: tabsFor,
  } = resources;
  const draftKey = actions.key;
  const draft = () => drafts.get(draftKey());
  const terminalConnections = createTerminalConnectionOwner();
  createEffect(
    () => sidecars.state.list.map((server) => sidecars.connection(server.id)),
    terminalConnections.update,
  );
  onCleanup(terminalConnections.stop);
  onCleanup(bindSourceSelectionCopy());
  const recentModel = createModelRecency({
    get: () => toggles.state.prefs["models.recent"],
    set: (value) => resources.setPreference("models.recent", value),
    fail: (cause) => navigation.fail(cause),
  });
  const settings = () => navigation.state.settings;
  const error = () => navigation.state.error;
  const project = () => navigation.state.project;
  const { fail, navigate, openProject } = navigation;
  const target = (direction: "back" | "forward") =>
    historyTarget(
      navigation.state.history,
      direction,
      ({ sidecarId, sessionID }) => {
        const entry = resources.connected(sidecarId) &&
          resources.entry(sidecarId, sessionID);
        if (!entry) return;
        return {
          title: entry.title,
          project: resources.checkoutLabel(
            sidecarId,
            resources.projectDirectory?.(
              sidecarId,
              entry.directory,
              entry.projectID,
            ) ?? entry.directory,
          ),
          deleted: !!entry.deleted,
        };
      },
      ({ sidecarId, directory }) =>
        resources.checkoutLabel(sidecarId, directory),
    );
  const backTarget = createMemo(() => target("back"));
  const forwardTarget = createMemo(() => target("forward"));
  const [dialog, setDialog] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  const [root, setRoot] = createSignal<HTMLDivElement>();
  const [transcriptLayer, setTranscriptLayer] = createSignal<HTMLDivElement>();
  const mountTranscriptLayer = (stage: HTMLDivElement) => {
    setTranscriptLayer(stage);
    return () =>
      setTranscriptLayer((current) => current === stage ? undefined : current);
  };
  const commands = new CommandHub(
    () => ({
      sidecar: session.state.selection?.sidecarId,
      session: session.state.selection?.sessionID,
      viewing: !settings(),
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
  createEffect(
    () => {
      const checkout = project(), selected = session.state.selection;
      return JSON.stringify([
        checkout?.sidecarId,
        checkout?.directory,
        selected?.sidecarId,
        selected?.sessionID,
        checkout && tabsFor(checkout).state.selected?.id,
      ]);
    },
    (current, previous) => {
      if (previous !== undefined && current !== previous) {
        keyboard.focusOwner.navigationChanged();
      }
    },
  );
  const notifications = applicationNotifications({
    commands,
    disclosures,
    prefs: () => toggles.state.prefs,
    selection: () => session.state.selection,
    viewing: () => !settings(),
    transcript: () => !branchHistory.state.opened,
    connection: (id) => sidecars.connection(id),
    entry,
    entities: resources.entities,
    observeEntries: resources.observeEntries,
  });
  createEffect(
    () =>
      sidecars.state.list.map(({ id, label, continuity }) => ({
        id,
        label,
        continuity,
      })),
    (list) => notifications.servers(list),
  );
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
      toggles.state.prefs.textSize,
    ],
    () => paintVisualPreferences(toggles.state.prefs),
  );
  createEffect(
    () => toggles.state.prefs.keymap,
    (value) => keyboard.keymap.setKeymap(value ?? {}),
  );
  onCleanup(
    commands.register({
      id: "history.back",
      title: "Go back",
      category: "Navigation",
      availability: () =>
        backTarget().enabled
          ? { available: true }
          : { available: false, reason: backTarget().label },
      run: () => navigation.traverse("back"),
    }),
  );
  onCleanup(
    commands.register({
      id: "history.forward",
      title: "Go forward",
      category: "Navigation",
      availability: () =>
        forwardTarget().enabled
          ? { available: true }
          : { available: false, reason: forwardTarget().label },
      run: () => navigation.traverse("forward"),
    }),
  );
  const historyControl = (direction: "back" | "forward") =>
    commands.control(`history.${direction}`, undefined, {
      target: { label: "Session history" },
      // This command resolves true only after navigation applies the browser's
      // matching entry. CommandHub rejects false before consulting this port.
      shown: () => true,
      unshown: "History navigation was declined.",
      recovery: "Try moving through history again.",
    });
  const historyBack = historyControl("back"),
    historyForward = historyControl("forward");
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
    savedCopies: (target) => branchHistory.finished(target).length,
    openSavedCopies: (target) => {
      const newest = branchHistory.finished(target)[0];
      if (!newest) return;
      const selected = session.state.selection;
      if (
        (selected?.sidecarId !== target.sidecarId ||
          selected.sessionID !== target.sessionID) &&
        !navigation.navigate(target)
      ) return;
      branchHistory.select(target);
      branchHistory.open(newest.id);
    },
    available: (target) =>
      actions.eligibility(target).live &&
      resources.connected(target.sidecarId) &&
      resources.advertised(target.sidecarId, "sessionActions"),
    rename,
    working: actions.working,
    helpers: (target) => Math.max(0, actions.familyEntries(target).length - 1),
    attention: (target) =>
      attentionCount(
        inbox(target.sidecarId).entities,
        entityKey("session", target.sessionID),
      ),
    clearAttention: (target) =>
      inbox(target.sidecarId).clearAttention({
        scope: "subtree",
        sessionID: target.sessionID,
      }),
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
  onCleanup(registerServerCommands(commands, (id) => sidecars.connection(id)));
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
  onCleanup(
    registerCodeBlockCommands(commands, (id) => sidecars.connection(id)),
  );
  onCleanup(
    registerFileCommands(
      commands,
      (id) => sidecars.connection(id),
      resources.fileFacts,
    ),
  );
  let openFileMenu: ((element: HTMLElement) => void) | undefined;
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
    run: (_ctx, target: SessionContextTarget) => copyText(target.title),
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
  const projects = createMemo(() => resources.projects(now()));
  const originalTitle = document.title;
  createEffect(
    () => {
      const selected = project();
      return shellTitle(
        info()?.title,
        selected &&
          resources.checkoutLabel(selected.sidecarId, selected.directory),
      );
    },
    (title) => {
      document.title = title;
    },
  );
  onCleanup(() => {
    document.title = originalTitle;
  });
  onSettled(() => {
    const stopNotifications = notifications.start(),
      stopKeyboard = keyboard.start(document, () => !!session.state.selection);
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
  registerWorkCommands({ commands }, {
    work,
    panels,
    selection: () => session.state.selection,
    ready: () =>
      toggles.state.ready && !settings() && !branchHistory.state.opened &&
      session.state.view !== "deleted",
    lastMessageID: (turn) =>
      session.transcript?.state.repliesByID[turn]?.lastID,
    layout,
    saveLayout,
  });
  return (
    <>
      <CommandProvider
        commands={commands}
        keyboard={keyboard}
        failureOwned={(cause) =>
          resources.ownsFailure?.(cause) || terminalRunFailureOwned(cause)}
      >
        <ShellProvider
          reload={reload}
          ports={{
            theme: props.theme,
            toggles,
            usage: session.usage,
            rename,
            projectRename,
            transcript: {
              messages: () => session.state.content.messages,
              exhausted: () => session.state.exhausted,
              paging: () => session.state.paging || session.state.loading,
              older: () => session.older(),
            },
            servers: () => sidecars.state.list,
            forms: resources.forms,
            filePaths: {
              facts: resources.fileFacts,
              api: (id) => sidecars.connection(id).base,
              entry: resources.entry,
              retainSessionReference: resources.retainSessionReference,
              entities: resources.entities,
              openMenu: (element) => openFileMenu?.(element),
              fail,
            },
            connection: (id) => sidecars.connection(id),
            inbox,
            approvals,
            openProject,
            addToPrompt: (text, label) => {
              const write = drafts.writer(draftKey());
              write((current) =>
                insertChip(
                  current,
                  current.input.length,
                  current.input.length,
                  label,
                  { kind: "text", text },
                )
              );
              void commands.run("prompt.focus").catch(fail);
            },
            project,
            entries,
            entry,
            projectEntries: resources.projectEntries,
            projectLabel: resources.projectLabel,
            projectMetadata: resources.projectMetadata,
            metadataEntry: resources.metadataEntry,
            sessionRows: resources.sessionRows,
            holdTaskOrder: resources.holdTaskOrder,
            sessionRowsReady: resources.sessionRowsReady,
            sessionRowsLoading: resources.sessionRowsLoading,
            sessionRowsStatus: resources.sessionRowsStatus,
            visibleRows: resources.visibleRows,
            projectProgress: resources.projectProgress,
            listInteraction,
            disclosures,
            work,
            selection: () => session.state.selection,
          }}
        >
          <div
            class="otk-app"
            ref={setRoot}
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
            data-left-collapsed={String(layout().leftCollapsed)}
            data-right-collapsed={String(layout().rightCollapsed)}
          >
            <ProjectInbox
              disclosure={disclosures}
              collapseToggle={
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
                </Show>
              }
              history={
                <HistoryButtons
                  back={backTarget()}
                  forward={forwardTarget()}
                  backAction={historyBack}
                  forwardAction={historyForward}
                  onFeedback={(outcome) => {
                    if (outcome.kind === "failed") {
                      fail(
                        new FeedbackFailure(outcome.feedback),
                      );
                    }
                  }}
                />
              }
              projects={projects()}
              duplicateName={resources.duplicateProjectName}
              projectLabel={resources.projectLabel}
              projectRename={projectRename}
              canRename={(row) =>
                canRenameProject(
                  row,
                  resources.server(row.sidecarId)?.capabilities ?? [],
                )}
              entities={resources.entities}
              servers={sidecars.state.list}
              selected={project()}
              prefs={toggles.state.prefs}
              ready={toggles.state.ready}
              onOpen={openProject}
              onAttention={navigation.openAttention}
              onInactive={resources.inactive}
              onMove={resources.moveProject}
              onLayout={saveLayout}
            />
            <main class="otk-main">
              <Show when={navigation.state.selectionNotice}>
                <div class="otk-selection-notice" role="status">
                  <ChromeMeta
                    title={navigation.state.selectionNotice}
                    class="otk-control-label"
                  >
                    {navigation.state.selectionNotice}
                  </ChromeMeta>
                </div>
              </Show>
              <Show
                when={settings()}
                fallback={
                  <Show
                    when={local().status !== "setup required"}
                    fallback={
                      <ScrollRegion class="otk-auth-view">
                        <Setup
                          onSetup={(input) =>
                            sidecars.connection(LOCAL_SIDECAR).setup(input)}
                        />
                      </ScrollRegion>
                    }
                  >
                    <Show
                      when={local().status !== "login required"}
                      fallback={
                        <ScrollRegion class="otk-auth-view">
                          <Login
                            label={local().label}
                            authType={local().authType}
                            onLogin={(input) =>
                              sidecars.connection(LOCAL_SIDECAR).login(input)}
                          />
                        </ScrollRegion>
                      }
                    >
                      <Show when={project()} keyed>
                        {(owner) => (
                          <>
                            <ProjectTabs
                              project={owner}
                              projectChip={
                                <ProjectLocation
                                  directory={owner.directory}
                                  sidecarId={owner.sidecarId}
                                  catalog={resources.declares(
                                      owner.sidecarId,
                                      "catalogs",
                                    )
                                    ? resources.directoryCatalog(
                                      owner.sidecarId,
                                      owner.directory,
                                    )
                                    : undefined}
                                />
                              }
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
                              text={transcriptStatus({
                                loading: session.state.loading,
                                paging: session.state.paging,
                                continuity: session.state.continuity,
                                transcript: session.transcript,
                              }) || (resources.progress(owner.sidecarId).busy
                                ? resources.progress(owner.sidecarId).text
                                : "")}
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
                        {(target) => (
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
                                        ...target,
                                        title: entry().title,
                                        directory: entry().directory,
                                      },
                                    }))}
                                    notice={`${
                                      entry().deleted?.how === "otk"
                                        ? "Deleted through OTK"
                                        : "Deleted from the agent service"
                                    } on ${clockTitle(entry().deleted!.at)}`}
                                    facts={deletedFacts(
                                      entry(),
                                      toggles.state.prefs.showCost,
                                      clockTitle,
                                    )}
                                    retained={guard.retained()}
                                    draftNotice={draft().input ||
                                        draft().chips.length || draft().editor
                                      ? "Your unsent draft is retained. This session can no longer receive messages."
                                      : undefined}
                                    copy={() =>
                                      void commands.run("session.title.copy", {
                                        ...target,
                                        title: entry().title,
                                        directory: entry().directory,
                                      }).catch(fail)}
                                    remove={actions.eligibility(target).member
                                      ? () =>
                                        void commands.run(
                                          "session.task.remove",
                                          target,
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
                                target,
                                resources,
                                actions,
                                session,
                                guard,
                                prefs: () => toggles.state.prefs,
                                tabs: () => {
                                  const owner = project();
                                  return owner ? tabsFor(owner) : undefined;
                                },
                              })}
                            >
                              <SessionView
                                mountTranscriptLayer={mountTranscriptLayer}
                                sidecarId={target.sidecarId}
                                revert={session.state.content.revert}
                                rollback={revert}
                                branchHistory={branchHistory}
                                strip={revert.strip(session.state.content)}
                                busy={sessionRunning(
                                  resources.inbox(target.sidecarId).entities,
                                  entityKey("session", target.sessionID),
                                )}
                                retryState={sessionEvidence(
                                  resources.inbox(target.sidecarId).entities,
                                  entityKey("session", target.sessionID),
                                )?.retry}
                                child={!!target.rootID ||
                                  !!info()?.parentID}
                                siblings={session.state.siblings}
                                onOpenChild={(id) =>
                                  void commands.run("session.child", id).catch(
                                    fail,
                                  )}
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
                                    target.sidecarId,
                                    "usage",
                                  ) &&
                                    actions.eligibility(target).live
                                  ? (turnID) => {
                                    const turn = { ...target, turnID };
                                    const release = session.usage.retain(turn);
                                    void session.usage.load(turn);
                                    return release;
                                  }
                                  : undefined}
                                usageError={(turnID) =>
                                  session.usage.error({
                                    ...target,
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
                                connected={resources.linked(target.sidecarId)}
                                onOlder={() => commands.run("session.older")}
                                onRetry={() => commands.run("session.retry")}
                                onDraft={drafts.writer(draftKey())}
                                captureSend={(draft) =>
                                  drafts.captureSend(draftKey(), draft)}
                                draftRecoveries={drafts.recoveries(draftKey())}
                                onPrompt={(parts, _mode, selection, capture) =>
                                  actions.prompt(parts, selection, capture)
                                    .then(
                                      requireCommittedSend,
                                    )}
                                activity={() => actions.activity()}
                                onStop={() => actions.stop()}
                              />
                            </SessionProvider>
                          </Show>
                        )}
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
                  addition={sidecars.state.addition}
                  onEditAdd={sidecars.editAdd}
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
              collapseToggle={
                <Show when={toggles.state.ready}>
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
              }
              layout={layout()}
              ready={toggles.state.ready}
              supports={(capability) =>
                resources.advertised(project()?.sidecarId ?? "", capability)}
              onLayout={saveLayout}
            />
            <Show when={root()}>
              <Portal mount={transcriptLayer() ?? root()}>
                <Toasts
                  layout={transcriptLayer() ? "layer" : undefined}
                  model={notifications.toast}
                  entities={resources.entities}
                  detail={permissionNotificationDetail}
                  onMore={() =>
                    void saveLayout({
                      rightCollapsed: false,
                      rightView: "sessions",
                    })
                      .catch(fail)}
                />
              </Portal>
            </Show>
            <DialogHost onChange={setDialog} />
            <ContextMenu
              root={root()!}
              control={(openFor) => openFileMenu = openFor}
            />
          </div>
        </ShellProvider>
      </CommandProvider>
    </>
  );
}
