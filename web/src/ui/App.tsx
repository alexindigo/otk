// SPDX-License-Identifier: LGPL-3.0-only
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { ContentSession } from "@otk/protocol";
import { createIndex, liveSessionInfo, sessionKey } from "../state/index.ts";
import {
  createSession,
  hashFor,
  route,
  type Selection,
} from "../state/session.ts";
import { createSidecars, LOCAL_SIDECAR } from "../state/sidecars.ts";
import { createNavigation } from "../state/navigation.ts";
import { oldestPermission } from "../state/permissions.ts";
import PermissionDock from "./PermissionDock.tsx";
import QuestionDock from "./QuestionDock.tsx";
import Sidebar from "./Sidebar.tsx";
import Settings from "./Settings.tsx";
import SessionView from "./SessionView.tsx";
import Login from "./Login.tsx";
import Setup from "./Setup.tsx";
import { createToggles } from "./Toggles.ts";
import DisplayMenu from "./DisplayMenu.tsx";
import { emptyDraft } from "./prompt/model.ts";
import { type HistoryEntry, mergeHistory } from "@otk/protocol";
import type {
  AgentOption,
  CommandOption,
  FileMatch,
  FrecencyEntry,
  PromptPart,
  ResourceOption,
} from "@otk/protocol";
export default function App() {
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
  );
  const entry = (sidecarId: string, id: string) =>
    index.state.entries[sessionKey(sidecarId, id)];
  const session = createSession((id) => sidecars.connection(id), entry);
  const toggles = createToggles((key, value) =>
    sidecars.connection(LOCAL_SIDECAR).rpc.call("prefs.set", { key, value })
  );
  const [settings, setSettings] = createSignal(false),
    [draft, setDraft] = createSignal(emptyDraft()),
    [error, setError] = createSignal("");
  const [permissionDirty, setPermissionDirty] = createSignal(false);
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
  onSettled(() => {
    navigation.start();
    sidecars.start();
    return () => {
      navigation.stop();
      session.stop();
      sidecars.stop();
    };
  });
  return (
    <div class="otk-app">
      <Sidebar
        sidecars={sidecars.state.list}
        entries={Object.values(index.state.entries)}
        selected={session.state.selection
          ? sessionKey(
            session.state.selection.sidecarId,
            session.state.selection.rootID || session.state.selection.sessionID,
          )
          : undefined}
        onOpen={(entry) =>
          navigate({ sidecarId: entry.sidecarId, sessionID: entry.id })}
        onCreate={(id, directory) => void create(id, directory)}
        onSettings={() => {
          navigationRevision++;
          setSettings(true);
        }}
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
                    onOpenChild={(id) => {
                      const selected = session.state.selection!;
                      let current = entry(selected.sidecarId, id);
                      let root = current
                        ? id
                        : selected.rootID || selected.sessionID;
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
                    }}
                    permissions={session.state.content.permissions}
                    prefs={toggles.state.prefs}
                    displayMenu={
                      <DisplayMenu
                        prefs={toggles.state.prefs}
                        ready={toggles.state.ready}
                        error={toggles.state.error}
                        onSet={(key, value) => toggles.set(key, value)}
                      />
                    }
                    permissionDock={
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
                            sidecars.connection(
                              session.state.selection!.sidecarId,
                            ).rpc.call<void>("permission.reply", input)}
                        />
                      </Show>
                    }
                    questionDock={
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
                            sidecars.connection(
                              session.state.selection!.sidecarId,
                            ).rpc.call<void>(
                              answers ? "question.reply" : "question.reject",
                              { requestID, ...(answers ? { answers } : {}) },
                            )}
                        />
                      </Show>
                    }
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
                    onOlder={() => session.older()}
                    onRetry={() => session.refetch()}
                    onDraft={(value) => setDraft(value)}
                    onFind={(query) => {
                      const target = session.state.selection!;
                      if (
                        !sidecars.connection(target.sidecarId).supports("files")
                      ) return Promise.resolve([]);
                      return sidecars.connection(target.sidecarId).rpc.call<
                        FileMatch[]
                      >("find.files", { sessionID: target.sessionID, query });
                    }}
                    onMentions={async (query) => {
                      const target = session.state.selection!,
                        connection = sidecars.connection(target.sidecarId),
                        rpc = connection.rpc,
                        directory = await directoryFor(target);
                      const [files, agents, resources, frecency] = await Promise
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
                      return { files, agents, resources, frecency, directory };
                    }}
                    onBump={async (path) => {
                      const target = session.state.selection!;
                      await sidecars.connection(target.sidecarId).rpc.call<
                        void
                      >("frecency.bump", { sessionID: target.sessionID, path });
                    }}
                    onCommands={() => {
                      const target = session.state.selection!;
                      if (
                        !sidecars.connection(target.sidecarId).supports(
                          "commands",
                        )
                      ) return Promise.resolve([]);
                      return sidecars.connection(target.sidecarId).rpc.call<
                        CommandOption[]
                      >("commands.list", { sessionID: target.sessionID });
                    }}
                    onCommand={async (command, args, parts) => {
                      const target = session.state.selection!;
                      return sidecars.connection(target.sidecarId).rpc.call<
                        void
                      >("session.command", {
                        sessionID: target.sessionID,
                        command,
                        arguments: args,
                        parts: (await attachments(parts, target.sidecarId))
                          .filter((
                            part,
                          ): part is Extract<PromptPart, { kind: "file" }> =>
                            part.kind === "file"
                          ),
                      });
                    }}
                    onNew={async () => {
                      const target = session.state.selection!,
                        directory = await directoryFor(target);
                      await create(target.sidecarId, directory);
                    }}
                    onHistory={async () =>
                      mergeHistory(
                        (await Promise.allSettled(
                          sidecars.state.list.filter((sidecar) =>
                            sidecar.status === "connected" &&
                            sidecar.capabilities.includes("history")
                          ).map((sidecar) =>
                            sidecars.connection(sidecar.id).rpc.call<
                              HistoryEntry[]
                            >("history.list", {}).then((entries) =>
                              entries.map((entry) => ({
                                ...entry,
                                parts: entry.parts.map((part) =>
                                  part.kind === "file" &&
                                    part.source === "history"
                                    ? { ...part, sidecarID: sidecar.id }
                                    : part
                                ),
                              }))
                            )
                          ),
                        )).flatMap((result) =>
                          result.status === "fulfilled" ? [result.value] : []
                        ),
                      )}
                    onPrompt={async (parts, mode) => {
                      const target = session.state.selection!;
                      if (mode === "shell") {
                        return sidecars.connection(target.sidecarId).rpc.call<
                          void
                        >("session.shell", {
                          sessionID: target.sessionID,
                          command: parts.filter((part) => part.kind === "text")
                            .map((part) => part.text).join("\n"),
                        });
                      }
                      return sidecars.connection(target.sidecarId).rpc.call<
                        void
                      >("session.prompt", {
                        sessionID: target.sessionID,
                        mode: "normal",
                        parts: await attachments(parts, target.sidecarId),
                      });
                    }}
                    onAbort={() => {
                      const target = session.state.selection!;
                      return sidecars.connection(target.sidecarId).rpc.call<
                        void
                      >("session.abort", { sessionID: target.sessionID });
                    }}
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
            onSetup={(input) => sidecars.connection(LOCAL_SIDECAR).setup(input)}
            onClose={() => setSettings(false)}
          />
        </Show>
      </main>
    </div>
  );
}
