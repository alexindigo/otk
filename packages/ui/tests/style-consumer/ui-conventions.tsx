// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, For, onSettled } from "solid-js";
import {
  createEntityStateStore,
  createLiveWork,
  elapsed,
  presentedEntity,
  presentFailure,
} from "@otk/client";
import TimeText from "../../components/TimeText.tsx";
import {
  DEFAULT_PREFS,
  entityKey,
  type EntityState,
  type ToolCall,
  type UserMessage,
} from "@otk/protocol";
import { useUiRegistries } from "../../registries/context.tsx";
import { useCommandPorts } from "../../keyboard/context.tsx";
import Message from "../../components/Message.tsx";
import ToolLine from "../../components/ToolLine.tsx";
import Todo from "../../components/Todo.tsx";
import Clock from "../../components/Clock.tsx";
import ChromeMeta from "../../components/ChromeMeta.tsx";
import { TreeIcon, TreeItem, TreeNode } from "../../components/Tree.tsx";
import StatusLight from "../../components/StatusLight.tsx";
import Subagents from "../../components/Subagents.tsx";
import { UnknownPart } from "../../components/parts/UnknownPart.tsx";
import "../../components/RightPanel.css" with { type: "text" };
import { registerTextPart } from "../../components/parts/TextPart.tsx";
import { registerFetchTool } from "../../components/tools/FetchTool.tsx";
import { registerQuestionTool } from "../../components/tools/QuestionTool.tsx";
import { registerSkillTool } from "../../components/tools/SkillTool.tsx";
import { registerTaskTool } from "../../components/tools/TaskTool.tsx";
import { registerWebSearchTool } from "../../components/tools/WebSearchTool.tsx";
import { registerGenericTool } from "../../components/tools/GenericTool.tsx";
const at = Date.parse("2026-11-20T01:23:00.107-08:00");

function SubagentTimes() {
  const { commands } = useCommandPorts();
  onSettled(() =>
    commands.register({
      id: "time-units.open-helper",
      title: "Open subagent",
      category: "Probe",
      run: () => {},
    })
  );
  const running = [
    ["Explore: find time formatters", 174_700],
    ["Junior: rewrite format.ts", 4_939_100],
    ["Review: check the plan", 97_500_000],
  ] as const;
  const blocked = "Grunt: collect build logs",
    unknown = "Scout: list call sites";
  const ids = [...running.map(([id]) => id), blocked, unknown];
  const counts = { working: 0, blocked: 0, finished: 0, unseen: 0 };
  const state = Object.fromEntries(ids.map((id, i): [string, EntityState] => {
    const run = running[i];
    return [entityKey("session", id), {
      ...presentedEntity(
        "session",
        id,
        run ? "working" : id === blocked ? "blocked" : "finished",
      ),
      evidence: {
        helper: run ? "running" : id === blocked ? "needsYou" : "finished",
        work: !!run,
        permissions: 0,
        questions: 0,
        descendants: counts,
        run: run && { startedAt: at - run[1] },
        waitingSince: id === blocked ? at - 47_300 : undefined,
      },
    }];
  }));
  const entities = createEntityStateStore({ read: () => state });
  const owner = createLiveWork({
    items: () =>
      running.map(([id]) => ({
        id,
        kind: "helper",
        label: id,
        title: id,
        sessionID: id,
      })),
    stopHelper: () => () => Promise.resolve(),
  });
  let home!: HTMLElement;
  return (
    <section class="style-panel" tabindex={-1} ref={(node) => home = node}>
      <h2>Subagents list</h2>
      <Subagents
        focusHome={() => home.focus()}
        entities={entities}
        helpers={{
          ids,
          counts: { running: running.length, needsYou: 1, finished: 1 },
          lamps: {
            all: { state: "blocked" },
            groups: {
              running: { state: "working" },
              needsYou: { state: "blocked" },
              finished: { state: "finished" },
            },
          },
        }}
        current={running[1][0]}
        owner={owner}
        title={(id) => id}
        agent={() => undefined}
        openAction={(id) =>
          commands.control("time-units.open-helper", undefined, {
            target: { label: id },
            shown: () => true,
            unshown: "The subagent did not open.",
            recovery: "Choose the subagent again",
          })}
      />
    </section>
  );
}

/** Controlled inputs go through the same owners as app data, not copied markup. */
export default function UiConventions() {
  const surface = new URL(location.href).searchParams.get("surface");
  if (surface === "subagents") return <SubagentTimes />;
  const registries = useUiRegistries();
  registerTextPart(registries.parts);
  for (
    const register of [
      registerFetchTool,
      registerQuestionTool,
      registerSkillTool,
      registerTaskTool,
      registerWebSearchTool,
      registerGenericTool,
    ]
  ) register(registries.tools);
  if (surface === "record-tree") {
    return (
      <section class="error-review-run">
        <h2>Record artwork and guide axes</h2>
        <For each={[false, true]} keyed={(outgoing) => String(outgoing)}>
          {(outgoing) => (
            <UnknownPart
              part={{
                kind: "external",
                id: outgoing() ? "outgoing-record" : "incoming-record",
                name: "consumer/record-axis",
                activity: {
                  layout: "row",
                  category: "record",
                  tone: "normal",
                  kindLabel: "Record",
                  title: outgoing() ? "Outgoing record" : "Incoming record",
                  direction: outgoing() ? "outgoing" : undefined,
                  icon: { name: "warning", label: "Record artwork" },
                },
              }}
              recordTime={at}
              prefs={DEFAULT_PREFS}
              streaming={false}
              permissions={[]}
              onOpenChild={() => {}}
              user={false}
            />
          )}
        </For>
      </section>
    );
  }
  if (surface === "send") {
    const message: UserMessage = {
      id: "pending",
      sessionID: "opcv2-ses_review",
      role: "user",
      time: { created: at },
      parts: [{
        id: "text",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{
            i: "text",
            text: "Keep the exact prompt while its outcome is checked.",
          }],
        }],
      }],
    };
    return (
      <section class="error-review-run">
        <h2>Prompt delivery</h2>
        <For
          each={["unknown", "rejected"] as const}
          keyed={(outcome) => outcome}
        >
          {(outcome) => {
            const feedback = presentFailure({
              code: "send.review",
              retry: "none",
              diagnosticID: `send-${outcome()}`,
              facts: {
                outcome: outcome(),
                actionLabel: "Sending prompt",
                target: {
                  sessionID: message.sessionID,
                  label: "Prompt delivery",
                },
                reason: outcome() === "unknown"
                  ? "The server has not confirmed the outcome"
                  : "The provider refused the request",
              },
            });
            return (
              <>
                <h3>
                  {outcome() === "unknown" ? "Unknown outcome" : "Failed send"}
                </h3>
                <Message
                  message={{ ...message, id: outcome() }}
                  prefs={{ ...DEFAULT_PREFS, timestamps: true }}
                  permissions={[]}
                  queued={false}
                  onOpenChild={() => {}}
                  send={{
                    phase: "failed",
                    intent: {
                      clientID: "review",
                      key: outcome(),
                    },
                    message,
                    feedback,
                  }}
                />
              </>
            );
          }}
        </For>
      </section>
    );
  }
  if (surface === "icons") {
    const base = {
      status: "completed" as const,
      time: { start: at - 65000, end: at },
      output: "Result retained",
    };
    const calls: ToolCall[] = [
      {
        ...base,
        callID: "fetch",
        tool: "fetch",
        url: "https://example.org/reference",
      },
      {
        ...base,
        callID: "question",
        tool: "question",
        questions: [{
          text: "Which approach?",
          options: [{ label: "Shared owner", description: "" }],
          answer: ["Shared owner"],
        }],
      },
      { ...base, callID: "skill", tool: "skill", name: "UI design" },
      {
        ...base,
        callID: "task",
        tool: "task",
        agent: "Junior",
        description: "Check shared UI conventions",
      },
      {
        ...base,
        callID: "web",
        tool: "websearch",
        query: "structural layouts",
      },
      {
        ...base,
        callID: "unknown",
        tool: "external",
        name: "custom-tool",
        summary: "Independent feature",
      },
    ];
    return (
      <section class="error-review-run">
        <h2>Tool artwork and duration owners</h2>
        <For each={calls} keyed={(call) => call.callID}>
          {(call) => (
            <ToolLine
              call={call()}
              prefs={DEFAULT_PREFS}
              genericOutput
              waiting={false}
              onOpenChild={() => {}}
            />
          )}
        </For>
        <h3>Tasks</h3>
        <Todo
          items={[
            { content: "Completed", status: "completed", priority: "medium" },
            {
              content: "In progress",
              status: "in_progress",
              priority: "medium",
            },
            { content: "Pending", status: "pending", priority: "medium" },
            { content: "Cancelled", status: "cancelled", priority: "medium" },
          ]}
        />
        <h3>Elapsed metadata</h3>
        <ChromeMeta>
          Loading messages... <TimeText time={elapsed(65000)} /> / Worked for
          {" "}
          <TimeText time={elapsed(65000)} /> / Live work{" "}
          <TimeText time={elapsed(65000)} />
        </ChromeMeta>
        <h3>Precise record time</h3>
        <Clock at={at} precise />
      </section>
    );
  }
  const [open, setOpen] = createSignal(true);
  return (
    <section class="error-review-run">
      <h2>Tree junctions on panel surfaces</h2>
      <div class="otk-right-panel">
        <div class="otk-panel-body">
          <h3>Sessions</h3>
          <TreeNode
            label="Task"
            open={open()}
            onOpen={setOpen}
            header={() => (
              <div class="otk-control-row">
                <TreeIcon>
                  <StatusLight state="working" />
                </TreeIcon>Task
              </div>
            )}
            body={() => (
              <For
                each={["First session", "Last session"]}
                keyed={(label) => label}
              >
                {(label, index) => (
                  <TreeItem last={index() === 1}>
                    <TreeNode
                      label={label()}
                      open={open()}
                      onOpen={setOpen}
                      hasChildren
                      header={() => (
                        <div class="otk-control-row">
                          <TreeIcon>
                            <StatusLight state="none" />
                          </TreeIcon>
                          {label()}
                        </div>
                      )}
                    />
                  </TreeItem>
                )}
              </For>
            )}
          />
        </div>
      </div>
    </section>
  );
}
