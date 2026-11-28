// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled } from "solid-js";
import {
  createDrafts,
  errorFeedback,
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

export default function NoticeLifetime(props: { structured?: boolean } = {}) {
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
    value = mode === "error" && props.structured
      ? errorFeedback(
        "The requested change was refused. Your input is kept. Review the target and try again when it is available. END OF REASON",
        {
          actionLabel: "Sending prompt",
          target: {
            sidecarId: "local",
            sessionID: "tstv1-notice",
            label: "Retained conversation",
          },
        },
      )
      : mode === "clear"
      ? undefined
      : {
        kind: mode,
        text: mode === "pending"
          ? "Sending response"
          : "Could not finish this action. Try again",
      };
    listeners.forEach((listener) => listener());
  };
  const drafts = createDrafts(solidState), write = drafts.writer("notice");
  const operation = solidState<SessionRevertState>({
    pending: "undo",
    phase: "staging",
    // Exercise the retained disclosure alongside 2.145's feedback. The
    // shared 2.114 fold only renders a control when there is a body to open.
    messages: [{
      id: "prompt",
      sessionID: "tstv1-notice",
      role: "user",
      time: { created: 1 },
      parts: [{
        id: "prompt-text",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: "Captured prompt" }],
        }],
      }],
    }],
    record: {
      boundaryID: "prompt",
      messageIDs: ["prompt"],
      files: [],
      prompt: { input: "Captured prompt", mode: "normal", parts: [], time: 1 },
    },
  });
  styleTest.failRollback = () =>
    operation.update((state) => {
      state.pending = undefined;
      state.phase = "failed";
      state.error = errorFeedback(
        "The requested change was refused. Your input is kept. Review the target and try again when it is available. END OF REASON",
        {
          actionLabel: "Restoring prompts",
          target: { label: "Retained conversation" },
        },
      );
    });
  const rollback: SessionRevert = {
    state: operation.state,
    matches: () => true,
    ready: () => undefined,
    confirm: () => Promise.resolve(),
    cancel() {},
    retry: () => Promise.resolve(),
    dismiss() {},
    revertTo: () => Promise.resolve(),
    restore: () => {
      setRestores(restores() + 1);
      return Promise.resolve();
    },
    undo: () => Promise.resolve(),
    redo: () => Promise.resolve(),
    hasPrompt: () => true,
    strip: () => undefined,
    dispose() {},
  };
  styleTest.resetNotice = () => {
    operation.update((state) => {
      state.pending = "undo";
      state.phase = "staging";
    });
    value = undefined;
    listeners.forEach((listener) => listener());
  };
  styleTest.settleNotice = () =>
    operation.update((state) => {
      state.pending = undefined;
      state.phase = "saved";
    });
  const [restores, setRestores] = createSignal(0);
  const [strip, setStrip] = createSignal<RevertStrip>({
    boundaryID: "prompt",
    messageIDs: ["prompt"],
    preview: "Captured prompt",
    files: [],
  });
  styleTest.refreshNotice = () => {
    setStrip({ ...strip(), messageIDs: [...strip().messageIDs] });
    operation.update((state) => {
      if (state.record) {
        state.record = {
          ...state.record,
          messageIDs: [...state.record.messageIDs],
        };
      }
    });
  };
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
    supports: (capability) => capability === "restore",
    rpc: () => Promise.reject(new Error("No RPC expected")),
    sessionID: () => "tstv1-notice",
    directory: () => Promise.resolve("/project"),
    entry: () => undefined,
    permissions: () => [],
    questions: () => [],
    prefs: () => DEFAULT_PREFS,
    dirty() {},
    act: (action) => action(),
    submit: async (action) => {
      await action(undefined, () => {}, "msg_fixture");
      return { kind: "committed", messageID: "msg_fixture" };
    },
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
          activity={() => ({ running: false, unstarted: 0 })}
          onStop={() => Promise.resolve()}
        />
      </SessionProvider>
    </div>
  );
}
