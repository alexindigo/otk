// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled } from "solid-js";
import {
  createDrafts,
  type Feedback,
  type FeedbackOwner,
  type RevertStrip,
  type SessionRevert,
  type SessionRevertState,
} from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import SessionView from "../../components/SessionView.tsx";
import {
  type SessionPorts,
  SessionProvider,
} from "../../registries/session.tsx";
import { solidState } from "../../state/binding.ts";
import { useCommandPorts } from "../../keyboard/context.tsx";
import "./notice-lifetime.css" with { type: "text" };

export default function NoticeLifetime() {
  let value: Feedback | undefined;
  const listeners = new Set<() => void>();
  const feedback: FeedbackOwner = {
    current: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    fail() {},
    clear() {},
  };
  styleTest.feedback = (mode) => {
    value = mode === "clear" ? undefined : {
      kind: mode,
      text: mode === "pending"
        ? "Sending response"
        : "Could not finish this action. Try again",
    };
    listeners.forEach((listener) => listener());
  };
  const drafts = createDrafts(solidState), write = drafts.writer("notice");
  const operation = solidState<SessionRevertState>({ pending: "undo" });
  const rollback: SessionRevert = {
    state: operation.state,
    matches: () => true,
    revertTo: () => Promise.resolve(),
    restore: () => Promise.resolve(),
    undo: () => Promise.resolve(),
    redo: () => Promise.resolve(),
    hasPrompt: () => true,
    strip: () => undefined,
    dispose() {},
  };
  styleTest.resetNotice = () => {
    operation.update((state) => {
      state.pending = "undo";
    });
    value = undefined;
    listeners.forEach((listener) => listener());
  };
  styleTest.settleNotice = () =>
    operation.update((state) => {
      state.pending = undefined;
    });
  const [restores, setRestores] = createSignal(0);
  const [strip, setStrip] = createSignal<RevertStrip>({
    count: 1,
    preview: "Captured prompt",
    prompts: [{ messageID: "prompt", preview: "Captured prompt", time: 1 }],
    more: 0,
    files: [],
  });
  styleTest.refreshNotice = () =>
    setStrip({ ...strip(), prompts: [...strip().prompts] });
  const { commands } = useCommandPorts();
  onSettled(() =>
    commands.register({
      id: "session.restore",
      title: "Restore",
      category: "Session",
      enabled: () => !operation.state.pending,
      run: () => {
        setRestores(restores() + 1);
      },
    })
  );
  const ports: SessionPorts = {
    supports: () => false,
    rpc: () => Promise.reject(new Error("No RPC expected")),
    sessionID: () => "tstv1-notice",
    directory: () => Promise.resolve("/project"),
    entry: () => undefined,
    permissions: () => [],
    questions: () => [],
    prefs: () => DEFAULT_PREFS,
    dirty() {},
    act: (action) => action(),
    submit: (action) => action(),
    history: () => Promise.resolve([]),
    attachments: (parts) => Promise.resolve(parts),
    feedback,
  };
  return (
    <div class="notice-lifetime-scene" data-restores={restores()}>
      <SessionProvider ports={ports}>
        <SessionView
          sidecarId="local"
          info={{
            id: "tstv1-notice",
            directory: "/project",
            projectID: "project",
            title: "Notice lifetime",
            archived: false,
            time: { created: 1, updated: 1 },
          }}
          label="Notice lifetime"
          messages={[]}
          loading={false}
          paging={false}
          exhausted
          draft={drafts.get("notice")}
          connected
          prefs={DEFAULT_PREFS}
          permissions={[]}
          siblings={[]}
          onOpenChild={() => {}}
          child={false}
          revert={null}
          busy={false}
          rollback={rollback}
          strip={strip()}
          onOlder={() => Promise.resolve()}
          onRetry={() => Promise.resolve()}
          onDraft={write}
          onPrompt={() => Promise.resolve()}
          onAbort={() => Promise.resolve()}
        />
      </SessionProvider>
    </div>
  );
}
