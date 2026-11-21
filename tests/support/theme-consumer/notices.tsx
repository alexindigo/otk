// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, For } from "solid-js";
import {
  CommandHub,
  createDrafts,
  errorFeedback,
  type SessionRevert,
  type SessionRevertState,
} from "@otk/client";
import type { Preferences } from "@otk/protocol";
import {
  CommandProvider,
  type SessionPorts,
  SessionProvider,
  SessionView,
  solidState,
} from "@otk/ui";

/** Independent public SessionView inputs, not an invented native revert failure. */
export default function Notices(props: { prefs: Preferences }) {
  const [mode, setMode] = createSignal("strip");
  const drafts = createDrafts(solidState),
    write = drafts.writer("theme-notice");
  const record = {
    boundaryID: "prompt",
    messageIDs: ["prompt"],
    files: [],
    prompt: {
      input: "Captured prompt",
      mode: "normal" as const,
      parts: [],
      time: 1,
    },
  };
  const operation = solidState<SessionRevertState>({ phase: "saved", record });
  const commands = new CommandHub();
  const rollback: SessionRevert = {
    state: operation.state,
    matches: () => true,
    ready: () => undefined,
    confirm: () => Promise.resolve(),
    cancel() {},
    retry: () => Promise.resolve(),
    dismiss() {},
    revertTo: () => Promise.resolve(),
    restore: () => Promise.resolve(),
    undo: () => Promise.resolve(),
    redo: () => Promise.resolve(),
    hasPrompt: () => true,
    strip: () => undefined,
    dispose() {},
  };
  const ports: SessionPorts = {
    supports: () => false,
    rpc: () =>
      Promise.reject(new Error("No native RPC in public notice scene")),
    sessionID: () => "tstv1-theme-notice",
    directory: () => Promise.resolve("/project"),
    entry: () => undefined,
    permissions: () => [],
    questions: () => [],
    prefs: () => props.prefs,
    dirty() {},
    act: (action) => action(),
    submit: (action) => action(),
    history: () => Promise.resolve([]),
    attachments: (parts) => Promise.resolve(parts),
  };
  const select = (value: string) => {
    setMode(value);
    operation.update((state) => {
      state.pending = value === "pending" ? "revert" : undefined;
      state.record = value === "fork" ? undefined : record;
      state.phase = value === "pending"
        ? "staging"
        : value === "error"
        ? "failed"
        : "saved";
      state.error = value === "error"
        ? errorFeedback("The requested rollback is no longer available", {
          actionLabel: "Rolling back conversation",
          target: {
            sessionID: "tstv1-theme-notice",
            label: "Public composer notice",
          },
        })
        : undefined;
    });
  };
  return (
    <CommandProvider commands={commands}>
      <nav aria-label="Public notice state">
        <For each={["strip", "pending", "error", "fork"]}>
          {(value) => (
            <button
              type="button"
              data-theme-notice={value}
              onClick={() => select(value)}
            >
              {value}
            </button>
          )}
        </For>
      </nav>
      <div class="theme-notice-session">
        <SessionProvider ports={ports}>
          <SessionView
            sidecarId="local"
            info={{
              id: "tstv1-theme-notice",
              directory: "/project",
              projectID: "project",
              title: "Public composer notice",
              archived: false,
              time: { created: 1, updated: 1 },
            }}
            label="Public composer notice"
            messages={[]}
            loading={false}
            paging={false}
            exhausted
            connected
            prefs={props.prefs}
            permissions={[]}
            siblings={[]}
            onOpenChild={() => {}}
            child={false}
            revert={null}
            busy={false}
            draft={drafts.get("theme-notice")}
            onDraft={write}
            onPrompt={() => Promise.resolve()}
            onAbort={() => Promise.resolve()}
            onOlder={() => Promise.resolve()}
            onRetry={() => Promise.resolve()}
            rollback={rollback}
            strip={mode() === "strip"
              ? {
                boundaryID: "prompt",
                messageIDs: ["prompt"],
                preview: "Captured prompt",
                files: [{ path: "revert.txt", additions: 1, deletions: 1 }],
              }
              : undefined}
            forkNote={mode() === "fork"
              ? { from: "Original conversation" }
              : undefined}
            onDismissForkNote={() => select("strip")}
          />
        </SessionProvider>
      </div>
    </CommandProvider>
  );
}
