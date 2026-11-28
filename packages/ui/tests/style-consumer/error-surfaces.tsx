// SPDX-License-Identifier: LGPL-3.0-only
import { onCleanup, onSettled, Show } from "solid-js";
import {
  attachmentFailure,
  CommandHub,
  errorFeedback,
  failureNote,
  presentFailure,
  type SidecarState,
} from "@otk/client";
import { createDisclosures } from "@otk/client";
import { solidState } from "../../state/binding.ts";
import { DEFAULT_PREFS, type PublicFailure } from "@otk/protocol";
import ProjectInbox from "../../components/ProjectInbox.tsx";
import ComposerNotice from "../../components/ComposerNotice.tsx";
import OperationFeedback from "../../components/OperationFeedback.tsx";
import FeedbackStatus from "../../components/FeedbackStatus.tsx";
import SessionError from "../../components/SessionError.tsx";
import PaneState from "../../components/PaneState.tsx";
import FieldFeedback from "../../components/FieldFeedback.tsx";
import Settings from "../../components/Settings.tsx";
import ProjectChip from "../../components/ProjectChip.tsx";
import ToolFrame from "../../components/tools/ToolFrame.tsx";
import { ToolIcon } from "../../components/ChromeIcons.tsx";
import Chips from "../../components/prompt/Chips.tsx";
import Message from "../../components/Message.tsx";
import { useUiRegistries } from "../../registries/context.tsx";
import { registerUnknownPart } from "../../components/parts/UnknownPart.tsx";
import { UnknownPart } from "../../components/parts/UnknownPart.tsx";
import Toasts from "../../components/Toasts.tsx";
import { applicationNotifications } from "../../shell/notifications.ts";
import "./error-surfaces.css" with { type: "text" };

const reason =
  "OTK returned invalid or interrupted request-event data (HTTP 503). The connection was interrupted before the server could confirm the result.";
const recovery =
  "Check that OTK is running and reachable, then reload this page";
const publicFailure: PublicFailure = {
  code: "consumer.connection",
  retry: "none",
  diagnosticID: "request-2-45-0123456789-abcdefghijklmnopqrstuvwxyz",
  facts: {
    actionLabel: "Checking OTK",
    target: { label: "http://ark.home:1502/api/" },
    reason,
    recovery,
  },
};
const connection = presentFailure(publicFailure);
const server: SidecarState = {
  id: "local",
  label: "This server",
  baseUrl: "",
  status: "reconnecting",
  harness: "reconnecting",
  capabilities: [],
  error: connection.text,
  ...{ feedback: connection },
};
const send = errorFeedback(
  "The model provider refused the request because the account has no remaining credit",
  {
    actionLabel: "Sending prompt",
    target: {
      sessionID: "opcv2-ses_review",
      label: "Error presentation review",
    },
    recovery: "Add credit to the provider account before sending again",
  },
)!;
const save = errorFeedback(
  "The server could not save the selected project name",
  {
    actionLabel: "Saving project",
    target: { label: "/home/tester/projects/error-presentation-review" },
  },
)!;

/** Production components with controlled failure facts; no duplicate error markup. */
export default function ErrorSurfaces() {
  const tree = createDisclosures({ factory: solidState });
  const surface = new URL(location.href).searchParams.get("surface") ?? "main";
  const failureTime = Date.parse("2026-11-20T01:23:00-08:00");
  const clockKnown =
    new URL(location.href).searchParams.get("clock") !== "unknown";
  if (surface === "run") {
    registerUnknownPart(useUiRegistries().parts);
    const failure: PublicFailure = {
      code: "native.execution",
      retry: "none",
      diagnosticID: "run-quota-failure",
      facts: {
        actionLabel: "Running session",
        target: {
          sessionID: "opcv2-ses_review",
          label: "Guest mode M4: video and sound",
        },
        reason: "The usage limit has been reached",
        recovery:
          "Check your provider quota or choose another available model, then send a new prompt",
        record: { messageID: "retained-run-failure" },
      },
    };
    return (
      <section class="error-review-run">
        <h2>Inline run failure</h2>
        <Message
          sessionTitle="Guest mode M4: video and sound"
          prefs={DEFAULT_PREFS}
          permissions={[]}
          onOpenChild={() => {}}
          queued={false}
          sourceTime={(id) =>
            id === "retained-run-failure" ? failureTime : undefined}
          sourceOutcomeTime={(id) =>
            id === "retained-run-failure"
              ? clockKnown
                ? { state: "known", at: failureTime, source: "error" }
                : {
                  state: "unknown",
                  reason: "No native timestamp was recorded",
                }
              : undefined}
          message={{
            id: "reply",
            sessionID: "opcv2-ses_review",
            role: "assistant",
            agent: "junior",
            model: { provider: "openai", model: "gpt-6.1-sol" },
            time: { created: failureTime - 180_000, completed: failureTime },
            terminal: true,
            interrupted: false,
            tokens: {
              input: null,
              output: null,
              reasoning: null,
              cache: { read: null, write: null },
            },
            cost: null,
            error: { kind: "usage-limit", message: failure.facts!.reason! },
            parts: [{
              kind: "external",
              id: "failure-record",
              name: "retained-error",
              failure,
            }],
          }}
        />
      </section>
    );
  }
  const notifications = applicationNotifications({
    commands: new CommandHub(),
    prefs: () => ({
      ...DEFAULT_PREFS,
      "notify.os": false,
      "notify.sound": false,
    }),
    selection: () => undefined,
    viewing: () => false,
    entry: () => undefined,
    observeEntries: () => () => {},
    connection: () => {
      throw new Error("No connection acquired");
    },
    entities: () => {
      throw new Error("No native attention acquired");
    },
  });
  onCleanup(() => notifications.stop());
  onSettled(() => {
    if (surface !== "main") return;
    notifications.hub.publish({
      id: "ordinary-review",
      kind: "info",
      title: "Project saved",
      body: "The selected project name was saved",
      actions: [],
    });
    notifications.hub.publish({
      ...failureNote(send)!,
      id: "error-review",
      actions: [],
    });
  });
  return (
    <Show
      when={surface !== "settings"}
      fallback={
        <div class="error-review-settings">
          <Settings
            sidecars={[server]}
            onAdd={() => Promise.resolve()}
            onRemove={() => {}}
            onLogin={() => Promise.resolve()}
            onSetup={() => Promise.resolve()}
            onClose={() => {}}
            discovery={{
              target: "http://ark.home:1502/api/",
              pending: false,
              steps: [{
                key: "connecting",
                label: "Connecting",
                elapsedMs: 1820,
                result: {
                  kind: "error",
                  text: connection.text,
                  feedback: connection,
                },
              }],
            }}
          />
        </div>
      }
    >
      <div class="error-review-layout">
        <ProjectInbox
          disclosure={tree}
          projects={[]}
          duplicateName={() => false}
          servers={[server]}
          prefs={DEFAULT_PREFS}
          ready
          onOpen={() => {}}
          onInactive={() => Promise.resolve()}
          onLayout={() => Promise.resolve()}
        />
        <div class="error-review-transcript">
          <header>
            <h2>Error presentation review</h2>
            <ProjectChip
              directory="/home/tester/projects/error-review"
              name="error-review"
              feedback={save}
            />
          </header>
          <section data-review-region="record">
            <h3>Transcript records and tools</h3>
            <UnknownPart
              recordTime={failureTime}
              failureTime={failureTime}
              prefs={DEFAULT_PREFS}
              streaming={false}
              permissions={[]}
              onOpenChild={() => {}}
              user={false}
              part={{
                kind: "external",
                id: "failure-record",
                name: "session-error",
                data: "",
                failure: publicFailure,
              }}
            />
            <ToolFrame
              call={{
                callID: "failed-tool",
                tool: "bash",
                command: "npm install",
                output: "Package registry unavailable",
                status: "error",
                error:
                  "The command exited with code 1 because the package registry is unavailable",
                time: { start: failureTime - 1000, end: failureTime },
              }}
              waiting={false}
              presentation={{
                verb: "Install dependencies",
                target: "/home/tester/projects/error-review",
                icon: ToolIcon,
              }}
              prefs={DEFAULT_PREFS}
              body={() => <p>Command output remains available.</p>}
            />
            <SessionError
              error="The model provider did not accept this request"
              target={{
                sessionID: "opcv2-ses_review",
                label: "Error presentation review",
              }}
            />
          </section>
          <section data-review-region="composer">
            <h3>Composer and send receipt</h3>
            <ComposerNotice>
              <OperationFeedback
                feedback={{
                  ...send,
                  action: { label: "Provider settings", run: () => {} },
                }}
              />
            </ComposerNotice>
            <Chips
              chips={[{
                id: "readable-attachment",
                label: "readable-notes.txt",
                part: {
                  kind: "file",
                  source: "path",
                  path: "/workspace/readable-notes.txt",
                },
              }, {
                id: "attachment",
                label: "unreadable-attachment.txt",
                part: {
                  kind: "file",
                  source: "path",
                  path: "/workspace/unreadable-attachment.txt",
                },
                error: attachmentFailure(
                  "The attachment could not be read",
                  "unreadable-attachment.txt",
                ),
              }]}
              onOpen={() => {}}
              onRemove={() => {}}
            />
            <label>
              Prompt<textarea value="Keep this draft while the failure is shown." />
            </label>
            <button type="button">Send</button>
          </section>
        </div>
        <aside class="error-review-panel">
          <h2>Panel feedback</h2>
          <FeedbackStatus
            compact
            feedback={{ ...save, action: { label: "Retry", run: () => {} } }}
          />
          <h3>Field feedback</h3>
          <FieldFeedback feedback={save} />
          <h3>Empty pane failure</h3>
          <div class="error-review-pane">
            <PaneState
              feedback={{
                ...send,
                action: { label: "Retry response", run: () => {} },
              }}
            />
          </div>
        </aside>
      </div>
      <Toasts model={notifications.toast} onMore={() => {}} />
    </Show>
  );
}
