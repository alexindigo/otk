// SPDX-License-Identifier: LGPL-3.0-only
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { ContentSession } from "../../../protocol/content.ts";
import { createIndex, liveSessionInfo, sessionKey } from "../state/index.ts";
import {
  createSession,
  hashFor,
  route,
  type Selection,
} from "../state/session.ts";
import { createSidecars, LOCAL_SIDECAR } from "../state/sidecars.ts";
import { createNavigation } from "../state/navigation.ts";
import Sidebar from "./Sidebar.tsx";
import Settings from "./Settings.tsx";
import SessionView from "./SessionView.tsx";
import Login from "./Login.tsx";
import Setup from "./Setup.tsx";
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
    },
  );
  const session = createSession((id) => sidecars.connection(id));
  const [settings, setSettings] = createSignal(false),
    [draft, setDraft] = createSignal(""),
    [error, setError] = createSignal("");
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
  const discardDraft = () =>
    !draft() ||
    globalThis.confirm("Discard the unsent prompt before switching sessions?");
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
    if (changes) setDraft("");
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
            session.state.selection.sessionID,
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
                    info={info()}
                    label={selectedSidecar()?.label || "Sidecar"}
                    messages={session.state.content.messages}
                    loading={session.state.loading}
                    paging={session.state.paging}
                    exhausted={session.state.exhausted}
                    error={session.state.error}
                    draft={draft()}
                    connected={selectedSidecar()?.status === "connected"}
                    onOlder={() => session.older()}
                    onRetry={() => session.refetch()}
                    onDraft={(value) => setDraft(value)}
                    onPrompt={(text) => {
                      const target = session.state.selection!;
                      return sidecars.connection(target.sidecarId).rpc.call<
                        void
                      >("session.prompt", {
                        sessionID: target.sessionID,
                        parts: [{ type: "text", text }],
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
