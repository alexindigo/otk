// SPDX-License-Identifier: LGPL-3.0-only
import "./App.css";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { type ContentSession, DEFAULT_PREFS } from "@otk/protocol";
import { apiBase, CommandHub } from "@otk/client";
import { registerSessionCommands } from "../commands/sessions.ts";
import { registerPreferenceCommands } from "../commands/preferences.ts";
import { registerAttentionCommands } from "../commands/attention.ts";
import {
  createCurrentClient,
  createNavigation,
  hashFor,
  liveSessionInfo,
  loadHistory,
  LOCAL_SIDECAR,
  oldestPermission,
  route,
  type Selection,
  sessionKey,
} from "@otk/client";
import {
  CommandProvider,
  createIndex,
  createKeyboard,
  createSession,
  createSidecars,
  createToggles,
  DisplayMenu,
  emptyDraft,
  KeysHelp,
  Login,
  Palette,
  PermissionDock,
  QuestionDock,
  SessionView,
  Settings,
  Setup,
  Sidebar,
  type ThemeEngine,
  ThemePicker,
} from "@otk/ui";
import type {
  AgentOption,
  CommandOption,
  FileMatch,
  FrecencyEntry,
  PromptPart,
  ResourceOption,
} from "@otk/protocol";
export default function App(props: { theme: ThemeEngine }) {
  const index = createIndex();
  const sidecars: ReturnType<typeof createSidecars> = createSidecars(
    (id, frame) => {
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        if (!index.receive(id, frame)) {
          sidecars.connection(id).send({ t: "resnapshot" });
        }
      }
      session.receive(id, frame);
      if (id === LOCAL_SIDECAR) toggles.receive(frame);
    },
    { connection: { api: apiBase("", import.meta.url) } },
  );
  const entry = (sidecarId: string, id: string) =>
    index.state.entries[sessionKey(sidecarId, id)];
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
  const [permissionDirty, setPermissionDirty] = createSignal(false);
  const [dialog, setDialog] = createSignal<"" | "palette" | "keys" | "theme">(
    "",
  );
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
    (error) => setError((error as Error).message),
    /Mac|iPhone|iPad/.test(navigator.platform),
  );
  onCleanup(
    commands.register({
      id: "palette.open",
      title: "Open command palette",
      category: "Commands",
      run: () => setDialog("palette"),
    }),
  );
  onCleanup(
    commands.register({
      id: "help.keys",
      title: "Keyboard shortcuts",
      category: "Commands",
      run: () => setDialog("keys"),
    }),
  );
  onCleanup(commands.register({
    id: "theme.open",
    title: "Choose theme",
    category: "Display",
    slash: ["theme"],
    run: () => setDialog("theme"),
  }));
  createEffect(
    () => toggles.state.prefs.theme,
    (id) => props.theme.commit(id ?? DEFAULT_PREFS.theme),
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
      set: (key, value) => toggles.set(key, value),
    }),
  );
  onCleanup(registerAttentionCommands(commands, {
    permission: (input) =>
      current.context().rpc.call<void>("permission.reply", input),
    question: (input) =>
      current.context().rpc.call<void>(
        input.answers ? "question.reply" : "question.reject",
        input,
      ),
  }));
  createEffect(
    () => toggles.state.prefs.keymap,
    (value) => keyboard.keymap.setKeymap(value ?? {}),
  );
  const [questionDirty, setQuestionDirty] = createSignal(false);
  const question = () => session.state.content.questions[0];
  const permission = createMemo(() => {
    const selected = session.state.selection;
    return selected
      ? oldestPermission(
        session.state.content.permissions,
        selected.sessionID,
        (id) => entry(selected.sidecarId, id),
      )
      : undefined;
  });
  const local = createMemo(() =>
    sidecars.state.list.find((item) => item.id === LOCAL_SIDECAR)!
  );
  const selectedSidecar = createMemo(() =>
    sidecars.state.list.find((item) =>
      item.id === session.state.selection?.sidecarId
    )
  );
  const info = createMemo(() => {
    const selected = session.state.selection;
    return liveSessionInfo(
      session.state.info,
      selected
        ? index.state
          .entries[sessionKey(selected.sidecarId, selected.sessionID)]
        : undefined,
    );
  });
  let navigationRevision = 0;
  const directoryFor = async (target: Selection): Promise<string> => {
    const current = info();
    if (
      current?.id === target.sessionID &&
      session.state.selection?.sidecarId === target.sidecarId
    ) return current.directory;
    return (await sidecars.connection(target.sidecarId).rpc.call<
      ContentSession
    >("session.get", { sessionID: target.sessionID })).directory;
  };
  const discardDraft = () =>
    (!draft().input && !draft().chips.length && !draft().editor &&
      !permissionDirty() && !questionDirty()) ||
    globalThis.confirm("Discard unsent text before switching sessions?");
  const applyRoute = (hash: string) => {
    const target = route(hash);
    const previous = session.state.selection;
    const changes = target?.sidecarId !== previous?.sidecarId ||
      target?.sessionID !== previous?.sessionID;
    if (
      target &&
      !sidecars.state.list.some((item) => item.id === target.sidecarId)
    ) {
      setError("The URL refers to an unknown sidecar. Add it in Settings.");
      session.open();
    } else {
      setError("");
      session.open(target);
    }
    if (changes) {
      setDraft(emptyDraft());
      setPermissionDirty(false);
      setQuestionDirty(false);
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
    if (navigation.open(hashFor(selection))) setSettings(false);
  };
  const create = async (sidecarId: string, directory: string) => {
    if (!discardDraft()) return;
    const revision = ++navigationRevision;
    try {
      const info = await sidecars.connection(sidecarId).rpc.call<
        ContentSession
      >("session.create", { directory });
      if (revision !== navigationRevision) return;
      navigate({ sidecarId, sessionID: info.id });
    } catch (error) {
      if (revision === navigationRevision) setError((error as Error).message);
    }
  };
  const attachments = (
    parts: PromptPart[],
    sidecarID: string,
  ): Promise<PromptPart[]> =>
    Promise.all(
      parts.map((part) =>
        part.kind === "file" && part.source === "history"
          ? sidecars.connection(part.sidecarID || sidecarID).rpc.call<
            Extract<PromptPart, { source: "upload" }>
          >("history.attachment", {
            messageID: part.messageID,
            partID: part.partID,
          })
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
        ? sidecars.state.list.find((sidecar) => sidecar.id === input.sidecarId)
          ?.status === "connected"
        : !!session.state.selection &&
          selectedSidecar()?.status === "connected",
    create: async (input) => {
      if (input) return await create(input.sidecarId, input.directory);
      const { selection: target } = current.context(),
        revision = navigationRevision;
      const directory = await directoryFor(target);
      if (revision === navigationRevision) {
        await create(target.sidecarId, directory);
      }
    },
    open: navigate,
    child: openChild,
    older: () => session.older(),
    retry: () => session.refetch(),
  }));
  onSettled(() => {
    const stopKeyboard = keyboard.start();
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
    navigation.start();
    sidecars.start();
    return () => {
      stopKeyboard();
      unbindPalette();
      unbindHelp();
      navigation.stop();
      session.stop();
      sidecars.stop();
    };
  });
  return (
    <CommandProvider commands={commands} keyboard={keyboard}>
      <div class="otk-app">
        <Sidebar
          actions={
            <>
              <button
                type="button"
                onClick={() => void commands.run("palette.open")}
              >
                Commands
              </button>
              <button
                type="button"
                onClick={() => void commands.run("help.keys")}
              >
                Keys
              </button>
            </>
          }
          sidecars={sidecars.state.list}
          entries={Object.values(index.state.entries)}
          selected={session.state.selection
            ? sessionKey(
              session.state.selection.sidecarId,
              session.state.selection.rootID ||
                session.state.selection.sessionID,
            )
            : undefined}
          onOpen={(entry) =>
            void commands.run("session.open", {
              sidecarId: entry.sidecarId,
              sessionID: entry.id,
            })}
          onCreate={(id, directory) =>
            void commands.run("session.new", { sidecarId: id, directory })}
          onSettings={() => void commands.run("settings.open")}
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
                  <Show
                    when={session.state.selection}
                    keyed
                    fallback={
                      <div class="otk-welcome">
                        <span class="otk-wordmark">OTK</span>
                        <h1>Open Terminal Kit</h1>
                        <p>Select a session or start a new one in a project.</p>
                      </div>
                    }
                  >
                    <SessionView
                      capabilities={selectedSidecar()?.capabilities || []}
                      historyEnabled={sidecars.state.list.some((sidecar) =>
                        sidecar.status === "connected" &&
                        sidecar.capabilities.includes("history")
                      )}
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
                      docks={{
                        get permissions() {
                          return (
                            <Show
                              when={selectedSidecar()?.capabilities.includes(
                                "permissions",
                              )}
                            >
                              <PermissionDock
                                request={permission()}
                                childTitle={permission()?.sessionID !==
                                    session.state.selection?.sessionID
                                  ? entry(
                                    session.state.selection!.sidecarId,
                                    permission()?.sessionID || "",
                                  )?.title || permission()?.sessionID
                                  : undefined}
                                onDirty={(value) => setPermissionDirty(value)}
                                onReply={(input) =>
                                  commands.run("permission.reply", input)}
                              />
                            </Show>
                          );
                        },
                        get questions() {
                          return (
                            <Show
                              when={selectedSidecar()?.capabilities.includes(
                                "questions",
                              )}
                            >
                              <QuestionDock
                                request={question()}
                                childTitle={question()?.sessionID !==
                                    session.state.selection?.sessionID
                                  ? entry(
                                    session.state.selection!.sidecarId,
                                    question()?.sessionID || "",
                                  )?.title
                                  : undefined}
                                onDirty={setQuestionDirty}
                                onReply={(requestID, answers) =>
                                  commands.run("question.reply", {
                                    requestID,
                                    ...(answers ? { answers } : {}),
                                  })}
                              />
                            </Show>
                          );
                        },
                      }}
                      info={info()}
                      label={selectedSidecar()?.label || "Sidecar"}
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
                      onFind={(query) => {
                        const { selection: target, connection } = current
                          .context();
                        if (
                          !connection.supports("files")
                        ) return Promise.resolve([]);
                        return connection.rpc.call<
                          FileMatch[]
                        >("find.files", { sessionID: target.sessionID, query });
                      }}
                      onMentions={async (query) => {
                        const { selection: target, connection, rpc } = current
                          .context();
                        const directory = await directoryFor(target);
                        const [files, agents, resources, frecency] =
                          await Promise
                            .all([
                              connection.supports("files")
                                ? rpc.call<FileMatch[]>("find.files", {
                                  sessionID: target.sessionID,
                                  query,
                                })
                                : [],
                              connection.supports("agents")
                                ? rpc.call<AgentOption[]>("agents.list", {
                                  sessionID: target.sessionID,
                                })
                                : [],
                              connection.supports("resources")
                                ? rpc.call<ResourceOption[]>("resources.list", {
                                  sessionID: target.sessionID,
                                })
                                : [],
                              rpc.call<FrecencyEntry[]>("frecency.list", {
                                sessionID: target.sessionID,
                              }),
                            ]);
                        return {
                          files,
                          agents,
                          resources,
                          frecency,
                          directory,
                        };
                      }}
                      onBump={async (path) => {
                        await current.call<void>("frecency.bump", { path });
                      }}
                      onCommands={() => {
                        const { selection: target, connection } = current
                          .context();
                        if (
                          !connection.supports(
                            "commands",
                          )
                        ) return Promise.resolve([]);
                        return connection.rpc.call<
                          CommandOption[]
                        >("commands.list", { sessionID: target.sessionID });
                      }}
                      onCommand={async (command, args, parts, agent) => {
                        const { selection: target, rpc } = current.context();
                        return rpc.call<
                          void
                        >("session.command", {
                          sessionID: target.sessionID,
                          command,
                          arguments: args,
                          ...(agent ? { agent } : {}),
                          parts: (await attachments(parts, target.sidecarId))
                            .filter((
                              part,
                            ): part is Extract<PromptPart, { kind: "file" }> =>
                              part.kind === "file"
                            ),
                        });
                      }}
                      onNew={() => commands.run("session.new")}
                      onAgents={() =>
                        current.call<AgentOption[]>("agents.list", {
                          primary: true,
                        })}
                      onHistory={async () =>
                        await loadHistory(
                          sidecars.state.list.filter((sidecar) =>
                            sidecar.status === "connected" &&
                            sidecar.capabilities.includes("history")
                          ).map((sidecar) => ({
                            id: sidecar.id,
                            connection: sidecars.connection(sidecar.id),
                          })),
                        )}
                      onPrompt={async (parts, mode, agent) => {
                        const { selection: target, rpc } = current.context();
                        if (mode === "shell") {
                          return rpc.call<
                            void
                          >("session.shell", {
                            sessionID: target.sessionID,
                            command: parts.filter((part) =>
                              part.kind === "text"
                            )
                              .map((part) => part.text).join("\n"),
                            ...(agent ? { agent } : {}),
                          });
                        }
                        return rpc.call<
                          void
                        >("session.prompt", {
                          sessionID: target.sessionID,
                          mode: "normal",
                          parts: await attachments(parts, target.sidecarId),
                          ...(agent ? { agent } : {}),
                        });
                      }}
                      onAbort={() => current.call<void>("session.abort", {})}
                    />
                  </Show>
                </Show>
              </Show>
            }
          >
            <Settings
              sidecars={sidecars.state.list}
              onAdd={async (url, label) => {
                await sidecars.add(url, label);
              }}
              onRemove={(id) => {
                if (session.state.selection?.sidecarId === id) {
                  if (!navigation.open("")) return;
                }
                index.remove(id);
                sidecars.remove(id);
              }}
              onLogin={(id, input) => sidecars.connection(id).login(input)}
              onSetup={(input) =>
                sidecars.connection(LOCAL_SIDECAR).setup(input)}
              onClose={() => void commands.run("settings.close")}
            />
          </Show>
        </main>
        <Show when={dialog() === "palette"}>
          <Palette onClose={() => setDialog("")} />
        </Show>
        <Show when={dialog() === "keys"}>
          <KeysHelp
            keymap={keyboard.keymap}
            ready={toggles.state.ready}
            onSave={async (value) => {
              await sidecars.connection(LOCAL_SIDECAR).rpc.call("prefs.set", {
                key: "keymap",
                value,
              });
            }}
            onClose={() => setDialog("")}
          />
        </Show>
        <Show when={dialog() === "theme"}>
          <ThemePicker
            theme={props.theme}
            ready={toggles.state.ready}
            onSave={async (value) => {
              await sidecars.connection(LOCAL_SIDECAR).rpc.call("prefs.set", {
                key: "theme",
                value,
              });
            }}
            onClose={() => setDialog("")}
          />
        </Show>
      </div>
    </CommandProvider>
  );
}
