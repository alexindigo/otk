// SPDX-License-Identifier: LGPL-3.0-only
import {
  createDisclosures,
  createTranscriptProjection,
  type SidecarState,
} from "@otk/client";
import { solidState } from "../../state/binding.ts";
import {
  DEFAULT_PREFS,
  type Derived,
  knownDerived,
  type Message as MessageData,
  type PublicFailure,
  type UsageSummary,
} from "@otk/protocol";
import ProjectInbox from "../../components/ProjectInbox.tsx";
import Settings from "../../components/Settings.tsx";
import Message from "../../components/Message.tsx";
import ActivityGroup from "../../components/ActivityGroup.tsx";
import WorkStrip from "../../components/WorkStrip.tsx";
import { workRuns } from "../../components/work-log.ts";
import Reasoning from "../../components/Reasoning.tsx";
import NativeSource from "../../components/parts/NativeSource.tsx";
import Timeline from "../../components/Timeline.tsx";
import Sidebar from "../../components/Sidebar.tsx";
import RevertGroup from "../../components/RevertGroup.tsx";
import StatusLight from "../../components/StatusLight.tsx";
import ConnectionLight from "../../components/ConnectionLight.tsx";
import { useUiRegistries } from "../../registries/context.tsx";
import { registerUnknownPart } from "../../components/parts/UnknownPart.tsx";
import { registerTextPart } from "../../components/parts/TextPart.tsx";
import "./error-surfaces.css" with { type: "text" };

const at = Date.parse("2026-11-20T01:23:00-08:00");
const server: SidecarState = {
  id: "local",
  label: "This server",
  baseUrl: "",
  status: "reconnecting",
  harness: "reconnecting",
  capabilities: [],
};
const failure: PublicFailure = {
  code: "native.execution",
  retry: "none",
  diagnosticID: "review-execution",
  facts: {
    actionLabel: "Execution failed",
    target: { sessionID: "opcv2-ses_review", label: "Media checks" },
    reason: "The usage limit has been reached",
    recovery:
      "Check your provider quota or choose another available model, then send a new prompt",
    record: { messageID: "reply" },
  },
};
const base = {
  sessionID: "opcv2-ses_review",
  role: "assistant" as const,
  agent: "junior",
  model: { provider: "openai", model: "gpt-6.1-sol" },
  terminal: true,
  interrupted: false,
  tokens: {
    input: 1200,
    output: 340,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
  cost: 0.04,
};
const records: MessageData[] = [
  {
    id: "helper",
    sessionID: base.sessionID,
    role: "context",
    time: { created: at },
    parts: [{
      kind: "external",
      id: "helper-part",
      name: "consumer/helper",
      activity: {
        layout: "row",
        category: "delegation",
        kindLabel: "Helper result",
        entity: { label: "Junior" },
        title: "failed",
        detail: "The helper session stopped responding",
        tone: "error",
        summary: {
          kind: "helper-failure",
          noun: "helper failed",
          plural: "helpers failed",
        },
      },
    }],
  },
  {
    id: "run",
    sessionID: base.sessionID,
    role: "context",
    time: { created: at },
    parts: [{
      kind: "external",
      id: "run-part",
      name: "consumer/run",
      failure,
      activity: {
        layout: "row",
        category: "record",
        kindLabel: "Execution",
        title: "Execution failed",
        detail: failure.facts!.reason,
        tone: "error",
        summary: { kind: "execution", noun: "run", plural: "runs" },
      },
    }],
  },
  {
    id: "permission",
    sessionID: base.sessionID,
    role: "context",
    time: { created: at },
    parts: [{
      kind: "external",
      id: "permission-part",
      name: "consumer/permission",
      activity: {
        layout: "row",
        category: "record",
        kindLabel: "Permission",
        title: "Permission granted",
        tone: "normal",
        summary: {
          kind: "permission",
          noun: "permission",
          plural: "permissions",
        },
      },
    }],
  },
  {
    id: "complete",
    sessionID: base.sessionID,
    role: "context",
    time: { created: at },
    parts: [{
      kind: "external",
      id: "complete-part",
      name: "consumer/complete",
      activity: {
        layout: "row",
        category: "record",
        kindLabel: "Execution",
        title: "Execution completed",
        tone: "normal",
        summary: { kind: "execution", noun: "run", plural: "runs" },
        completion: { placement: "footer" },
      },
    }],
  },
];

/** Shared production consumers with fixed facts for placement/geometry regression. */
export default function FailureLayout() {
  const tree = createDisclosures({ factory: solidState });
  const surface = new URL(location.href).searchParams.get("surface");
  const registry = useUiRegistries();
  registerUnknownPart(registry.parts);
  registerTextPart(registry.parts);
  const message = (value: MessageData, summary?: Derived<UsageSummary>) => (
    <Message
      message={value}
      summary={summary}
      prefs={DEFAULT_PREFS}
      permissions={[]}
      queued={false}
      onOpenChild={() => {}}
    />
  );
  if (surface === "metadata") {
    const user: MessageData = {
      id: "user-queued",
      sessionID: base.sessionID,
      role: "user",
      time: { created: at },
      parts: [{
        kind: "text",
        id: "queued-text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{
            i: "text",
            text: "Keep this queued prompt in its ordinary bubble.",
          }],
        }],
      }],
    };
    return (
      <section class="error-review-run">
        <h2>Prompt metadata and independent disclosures</h2>
        <Message
          message={user}
          prefs={{ ...DEFAULT_PREFS, timestamps: true }}
          permissions={[]}
          queued
          onOpenChild={() => {}}
        />
        <Message
          message={{ ...user, id: "user-pending" }}
          prefs={{ ...DEFAULT_PREFS, timestamps: true }}
          permissions={[]}
          queued={false}
          onOpenChild={() => {}}
          send={{
            phase: "pending",
            message: { ...user, id: "user-pending" },
            intent: {
              clientID: "style",
              key: "metadata-send",
            },
          }}
        />
        <h3>Work and source</h3>
        <WorkStrip
          runs={workRuns({
            parts: [{ kind: "meta", id: "check" }],
            terminal: true,
            now: 2000,
            presentation: () => ({
              work: { start: 1000, end: 2000 },
              run: { label: "Check output" },
            }),
          })}
          shown={false}
          action={() => ({
            availability: () => ({ available: true }),
            subscribe: () => () => {},
            run: () => Promise.resolve({ kind: "shown" }),
          })}
        />
        <Reasoning
          part={{
            kind: "reasoning",
            id: "thought",
            title: "Plan the verification",
            time: { start: at - 4000, end: at },
            blocks: [{
              b: "paragraph",
              inline: [{
                i: "text",
                text: "Check shared owners before their consumers.",
              }],
            }],
          }}
          mode="hide"
        />
        <NativeSource
          prefs={DEFAULT_PREFS}
          preview={{ text: '{"kind":"retained"}', bytes: 19, truncated: false }}
        />
        <h3>Timeline</h3>
        <Timeline
          session={{ sidecarId: "local", sessionID: base.sessionID }}
          prompts={[{ id: user.id, time: at, queued: true, parts: user.parts }]}
          exhausted
          paging={false}
          preview={() => "Queued prompt in Timeline"}
          onOlder={() => Promise.resolve()}
          onReveal={() => Promise.resolve()}
        />
        <RevertGroup
          group={{
            key: "revert:earlier",
            title: "Reverted",
            members: [],
            revision: 0,
          }}
          prefs={DEFAULT_PREFS}
          onOpenChild={() => {}}
          state={{
            phase: "saved",
            record: {
              boundaryID: "earlier",
              messageIDs: ["earlier"],
              prompt: {
                input: "Earlier prompt",
                mode: "normal",
                parts: [],
                time: 1,
              },
              files: [],
            },
          }}
        />
        <h3>Indicator artwork</h3>
        <div class="otk-control-row">
          {(["blocked", "working", "finished", "none"] as const).map((
            state,
          ) => (
            <span>
              <StatusLight state={state} /> {state}
            </span>
          ))}
          <span>
            <ConnectionLight
              connection={{
                ...server,
                status: "connected",
                harness: "connected",
              }}
            />{" "}
            Connected
          </span>
          <span>
            <ConnectionLight connection={server} /> Reconnecting
          </span>
          <span>
            <ConnectionLight
              connection={{ ...server, error: "The server is unavailable" }}
            />{" "}
            Error
          </span>
        </div>
      </section>
    );
  }
  if (surface === "legacy-sidebar") {
    return (
      <div style={{ width: "320px", height: "800px" }}>
        <Sidebar
          sidecars={[server]}
          entries={[]}
          onOpen={() => {}}
          onCreate={() => {}}
          onSettings={() => {}}
        />
      </div>
    );
  }
  if (surface === "settings") {
    return (
      <div class="error-review-settings">
        <Settings
          sidecars={[server]}
          onAdd={() => Promise.resolve()}
          onRemove={() => {}}
          onLogin={() => Promise.resolve()}
          onSetup={() => Promise.resolve()}
          onClose={() => {}}
        />
      </div>
    );
  }
  if (surface === "reconnect") {
    return (
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
        <div />
        <div />
      </div>
    );
  }
  if (surface === "interval") {
    const projection = createTranscriptProjection();
    projection.reset(records);
    const group =
      projection.state.records.groups[projection.state.records.keys[0]];
    return (
      <section class="error-review-run">
        <h2>Background activity</h2>
        <ActivityGroup
          group={group}
          prefs={DEFAULT_PREFS}
          body={() => records.map((value) => message(value))}
          breakouts={() => records.slice(0, 2).map((value) => message(value))}
        />
      </section>
    );
  }
  return (
    <section class="error-review-run">
      <h2>Reply outcome clocks</h2>
      {message({
        ...base,
        id: "ok",
        time: { created: at - 600_000, completed: at - 420_000 },
        outcomeTime: { state: "known", at: at - 420_000, source: "completed" },
        parts: [{
          kind: "text",
          id: "ok-text",
          synthetic: false,
          blocks: [{
            b: "paragraph",
            inline: [{ i: "text", text: "Finished the media checks." }],
          }],
        }],
      })}
      {message({
        ...base,
        id: "reply",
        time: { created: at - 180_000, completed: at },
        outcomeTime: { state: "known", at, source: "error" },
        error: { kind: "usage-limit", message: failure.facts!.reason! },
        parts: [{
          kind: "external",
          id: "failure-record",
          name: "consumer/failure",
          failure,
        }],
      })}
      {message(
        {
          ...base,
          id: "unknown",
          time: { created: at - 60_000 },
          outcomeTime: {
            state: "unknown",
            reason:
              "No native completion, error or part timestamp was recorded.",
          },
          parts: [],
        },
        knownDerived(
          {
            calls: 1,
            tokens: base.tokens,
            cost: base.cost,
            contextPeak: 1200,
            timing: {
              state: "unknown",
              start: at - 60_000,
              terminal: true,
              reason: "migration",
              explanation:
                "The real end time was lost when opencode migrated this session.",
            },
          },
          "style-fixture",
          1,
          true,
        ),
      )}
    </section>
  );
}
