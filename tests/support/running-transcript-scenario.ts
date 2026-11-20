// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import type { Harness, HarnessSink } from "@otk/harness";
import { ContentReplay } from "@otk/harness";
import type {
  ContentSession,
  FormRequest,
  IndexEntry,
  Message,
  PermissionRequest,
  QuestionRequest,
} from "@otk/protocol";
import { startApplication } from "../../application.ts";
import { cfg, fixture } from "./config.ts";
import { fixturePage } from "./message-pages.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { resources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";

/** A running source, with fixture-owned native inputs and no product UI hooks. */
export async function runningTranscriptScenario() {
  const root = await fixture(), settings = cfg(), id = "tstv1-running-layout";
  settings.auth.type = "none";
  settings.server.port = 0;
  settings.state.path = root + "/state";
  const info: ContentSession = {
    id,
    directory: root,
    projectID: "layout",
    title: "Running layout",
    archived: false,
    time: { created: 1, updated: 1 },
  };
  const entry: IndexEntry = {
    digest: { state: "digesting", revision: 0, turns: {} },
    id,
    directory: root,
    projectID: "layout",
    title: info.title,
    archived: false,
    timeCreated: 1,
    timeUpdated: 1,
    status: "busy",
    activity: { work: { keys: ["native-run"], fresh: true } },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  const messages: Message[] = [{
    id: "prompt",
    sessionID: id,
    role: "user",
    time: { created: 1 },
    parts: [{
      id: "prompt-text",
      kind: "text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: "Keep working while layout is observed" }],
      }],
    }],
  }, {
    id: "answer",
    sessionID: id,
    role: "assistant",
    replyTo: "prompt",
    agent: "build",
    model: { provider: "fixture", model: "scripted" },
    time: { created: 2 },
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts: [{
      id: "answer-text",
      kind: "text",
      synthetic: false,
      blocks: Array.from(
        { length: 35 },
        (_, n) => ({
          b: "paragraph" as const,
          inline: [{
            i: "text" as const,
            text: `Running paragraph ${n}. ` +
              "Stable source geometry during status publication. ".repeat(6),
          }],
        }),
      ),
    }, {
      id: "tool",
      kind: "tool",
      call: {
        callID: "call",
        tool: "bash",
        status: "completed",
        title: "Existing execution row",
        command: "printf layout",
        output: "layout",
        time: { start: 2, end: 3 },
      },
    }],
  }];
  const entries = new Map([[id, entry]]);
  const sessionInfo = (sessionID: string): ContentSession => {
    const value = entries.get(sessionID);
    if (!value) throw new Error("Unknown running-layout session");
    return {
      id: value.id,
      directory: value.directory,
      projectID: value.projectID,
      parentID: value.parentID,
      title: value.title,
      archived: false,
      time: { created: value.timeCreated, updated: value.timeUpdated },
    };
  };
  let permissionSequence = 0;
  let helperPublication = 0;
  const retrySeconds = [100, ...Array<number>(12).fill(100), 99, 10, 9, 1];
  let sink!: HarnessSink,
    recordCount = 0,
    permissions: PermissionRequest[] = [],
    questions: QuestionRequest[] = [],
    forms: FormRequest[] = [];
  const formListeners = new Set<() => void>(),
    replyGates = new Map<string, () => void>();
  const replay = new ContentReplay({
    ...settings.messages,
    nonce: () => crypto.randomUUID(),
    emit: (session, op, clock) => sink.content(session, op, clock),
  });
  const emit = (op: import("@otk/protocol").ContentOp) =>
    replay.publish(id, op);
  const metadata = () => {
    entry.attention.permissions = permissions.length;
    entry.attention.questions = questions.length;
    entry.activity = {
      work: { keys: ["native-run"], fresh: true },
      permissions: { keys: permissions.map((p) => p.id), fresh: true },
      inputs: { keys: questions.map((q) => q.id), fresh: true },
    };
    sink.indexUpsert({ ...entry, attention: { ...entry.attention } });
  };
  const removePermission = (requestID: string) => {
    permissions = permissions.filter((p) => p.id !== requestID);
    emit({ op: "permission.remove", sessionID: id, requestID });
    replyGates.get(requestID)?.();
    replyGates.delete(requestID);
    metadata();
  };
  const backend: Harness = {
    core: {
      kind: "external",
      version: "fixture",
      start(value) {
        sink = value;
        sink.connection("connected");
        sink.indexReset([...entries.values()]);
        return Promise.resolve();
      },
      stop: async () => {},
      subscriptions() {},
      identities: (ids) =>
        Promise.resolve(
          ids.filter((id) => entries.has(id)).map((id) => ({
            id,
            directory: root,
            parentID: entries.get(id)!.parentID,
          })),
        ),
      getSession: (sessionID) => Promise.resolve(sessionInfo(sessionID)),
      createSession: () => Promise.resolve(info),
      listChildren: (sessionID) =>
        Promise.resolve(
          [...entries.values()].filter((e) => e.parentID === sessionID).map((
            e,
          ) => sessionInfo(e.id)),
        ),
      listSessions: (input) =>
        Promise.resolve({
          items: [...entries.values()].filter((e) =>
            input.parentID === undefined || (input.parentID === null
              ? !e.parentID
              : e.parentID === input.parentID)
          ),
          older: null,
          generation: "layout",
        }),
      listMessages: (sessionID, options) =>
        Promise.resolve(
          fixturePage(
            sessionID,
            sessionID === id ? messages : [],
            options.before,
            info,
            replay.clock(id),
          ),
        ),
    },
    capabilities: {
      prompt: { prompt: async () => {}, abort: async () => {} },
      permissions: {
        listPermissions: () => Promise.resolve([...permissions]),
        replyPermission: ({ requestID }) =>
          new Promise<void>((resolve) => replyGates.set(requestID, resolve)),
      },
      questions: {
        listQuestions: () => Promise.resolve([...questions]),
        answerQuestion: (requestID) => {
          questions = questions.filter((q) => q.id !== requestID);
          emit({ op: "question.remove", sessionID: id, requestID });
          metadata();
          return Promise.resolve();
        },
      },
      forms: {
        list: () => Promise.resolve(forms),
        reply: async () => {},
        cancel: async () => {},
        watch(listener) {
          formListeners.add(listener);
          return () => {
            formListeners.delete(listener);
          };
        },
      },
    },
  };
  const app = await startApplication(
    settings,
    backend,
    fromFileUrl(new URL("../../web/dist/", import.meta.url)),
  );
  resources().defer("running layout application", () => {
    for (const resolve of replyGates.values()) resolve();
    return app.stop();
  });
  const url = `http://127.0.0.1:${app.server.addr.port}`,
    client = new WsClient(url);
  await client.connect(root);
  resources().defer("running layout observer", () => client.close());
  const baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined;
  const stack = {
    root,
    url,
    nativeUrl: "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [app.server.addr.port],
  };
  const registration = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (registration) {
    await Deno.writeTextFile(registration, JSON.stringify(stack));
  }
  return {
    info: stack,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign running layout lease");
      switch (frame.command) {
        case "beginTest":
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return {
            session: id,
            permissions: permissions.length,
            records: recordCount,
            running: true,
          };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "scenario": {
          const { action, sessionID, target } = frame.params;
          if (target === "backgrounds") {
            if (
              action === "release" || action === "thaw" || action === "stop"
            ) {
              // Publish a replacement of the original record, as inbox delivery does.
              for (let n = 2; n < messages.length; n++) {
                const message = messages[n], part = message.parts[0];
                if (part.kind !== "external" || !part.activity) continue;
                const next: Message = {
                  ...message,
                  parts: [{
                    ...part,
                    activity: {
                      ...part.activity,
                      tone: "normal",
                      state: {
                        key: "done",
                        label: "Done",
                        facts: { active: false, terminal: true },
                      },
                    },
                  }],
                };
                messages[n] = next;
                emit({ op: "message.upsert", message: next });
              }
            } else if (action === "disconnect") {
              const previous = messages.at(-1)!, part = previous.parts[0];
              if (part.kind !== "external" || !part.activity) {
                throw new Error("Missing background record");
              }
              const message: Message = {
                ...previous,
                parts: [{
                  ...part,
                  activity: {
                    ...part.activity,
                    tone: "error",
                    title: "Background failed",
                    state: {
                      key: "failed",
                      label: "Failed",
                      facts: { active: false, terminal: true },
                    },
                  },
                }],
              };
              messages[messages.length - 1] = message;
              emit({ op: "message.upsert", message });
            } else if (action === "fail") {
              emit({
                op: "session.error",
                errorState: {
                  revision: 1,
                  observations: [{
                    id: "background-reveal",
                    source: "event",
                    message: "Background result",
                    failure: {
                      code: "request.params",
                      retry: "none",
                      diagnosticID: "background-reveal",
                      facts: {
                        origin: "composer",
                        actionLabel: "Sending prompt",
                        reason: "Background result",
                        target: { sessionID: id },
                        record: {
                          messageID: messages.at(-1)!.id,
                          label: "See response",
                        },
                      },
                    },
                  }],
                },
              });
            } else {
              const helper = action === "hold",
                completion = action === "succeed";
              const number = ++recordCount;
              const message: Message = {
                id: `background-${number}`,
                sessionID: id,
                role: "context",
                time: { created: 100 + number },
                source: {
                  kind: "fixture",
                  payload: `Original background ${number}`,
                },
                parts: [{
                  id: `background-part-${number}`,
                  kind: "external",
                  name: "fixture/background",
                  source: {
                    kind: "fixture",
                    preview: `Original background ${number}`,
                    bytes: 32,
                    truncated: false,
                  },
                  activity: {
                    kindLabel: "Opaque",
                    summary: helper
                      ? {
                        kind: "helper",
                        noun: "helper finished",
                        plural: "helpers finished",
                      }
                      : completion
                      ? { kind: "run", noun: "run", plural: "runs" }
                      : {
                        kind: "permission",
                        noun: "permission",
                        plural: "permissions",
                      },
                    ...(completion
                      ? { completion: { placement: "footer" as const } }
                      : {}),
                    title: helper
                      ? "finished"
                      : completion
                      ? "Run succeeded"
                      : "Permission once",
                    ...(helper
                      ? {
                        entity: { label: "Junior" },
                        child: { sessionID: id, label: "Open task" },
                        detail: number % 4 === 0
                          ? "Inspect plugin settings host"
                          : "Preserve untouched overrides",
                      }
                      : {}),
                    layout: "row",
                    category: helper ? "delegation" : "record",
                    tone: "normal",
                    state: {
                      key: completion ? "done" : "queued",
                      label: completion ? "Done" : "Queued",
                      facts: { active: false, terminal: completion },
                    },
                    parameters: [{
                      key: "outcome",
                      label: "Outcome",
                      value: completion ? "succeeded" : "once",
                    }],
                  },
                }],
              };
              messages.push(message);
              emit({ op: "message.upsert", message });
            }
            return null;
          }
          if (action === "hold") {
            const count = sessionID === id ? 1 : 15;
            for (let n = 0; n < count; n++) {
              const request: PermissionRequest = {
                id: `permission-${++permissionSequence}`,
                sessionID: id,
                kind: "bash",
                title: "Runtime approval",
                patterns: ["printf layout"],
                alwaysPatterns: [],
                time: Date.now(),
                detail: { kind: "bash", command: "printf layout" },
              };
              permissions.push(request);
              emit({ op: "permission.upsert", request });
            }
            metadata();
          } else if (action === "release") {
            if (permissions[0]) removePermission(permissions[0].id);
          } else if (action === "freeze" && sessionID === id) {
            questions = [{
              id: "question-layout",
              sessionID: id,
              questions: [{
                text: "Runtime question",
                options: [{
                  label: "Keep working",
                  description: "A stable transcript",
                }],
                custom: true,
                multiple: false,
              }],
            }];
            emit({ op: "question.upsert", request: questions[0] });
            metadata();
          } else if (action === "thaw") {
            forms = [{
              id: "form-layout",
              owner: { kind: "session", sessionID: id },
              directory: root,
              title: "Runtime form",
              fields: Array.from(
                { length: 14 },
                (_, n) => ({
                  key: `field-${n}`,
                  title: `Field ${n}`,
                  type: "string" as const,
                }),
              ),
            }];
            for (const listener of formListeners) listener();
          } else if (action === "succeed" && sessionID === id) {
            const seconds = retrySeconds.shift() ?? 1;
            entry.status = "retry";
            entry.retry = {
              attempt: seconds,
              message: "Waiting for the next native attempt",
              next: Date.now() + seconds * 1000,
            };
            metadata();
          } else if (action === "succeed") {
            const count = [1, 4, 0][helperPublication++ % 3];
            for (let n = 0; n < 4; n++) {
              const helper: IndexEntry = {
                ...entry,
                id: `tstv1-layout-helper-${n}`,
                parentID: id,
                title: `Layout helper ${n}`,
                activity: {
                  work: { keys: n < count ? [`helper-${n}`] : [], fresh: true },
                },
              };
              entries.set(helper.id, helper);
              sink.indexUpsert(helper);
            }
          } else if (action === "fail") {
            emit({
              op: "session.error",
              errorState: {
                revision: 1,
                observations: [{
                  id: "layout-pointer",
                  source: "event",
                  message: "Runtime notice",
                  failure: {
                    code: "request.params",
                    retry: "none",
                    diagnosticID: "layout-pointer",
                    facts: {
                      origin: "composer",
                      actionLabel: "Sending prompt",
                      reason: "Runtime notice",
                      target: { sessionID: id },
                      record: {
                        messageID: recordCount ? "record-10" : "answer",
                        label: "See response",
                      },
                    },
                  },
                }],
              },
            });
          } else if (action === "disconnect") {
            sink.connection("reconnecting");
          } else if (action === "stop") {
            for (const permission of [...permissions]) {
              removePermission(
                permission.id,
              );
            }
            for (const question of questions) {
              emit({
                op: "question.remove",
                sessionID: id,
                requestID: question.id,
              });
            }
            questions = [];
            forms = [];
            for (const listener of formListeners) listener();
            metadata();
            sink.connection("connected");
            emit({
              op: "session.error",
              errorState: { revision: 2, observations: [] },
            });
          } else {
            const record: Message = {
              id: `record-${++recordCount}`,
              sessionID: id,
              role: "context",
              time: { created: 100 + recordCount },
              parts: [{
                id: `record-part-${recordCount}`,
                kind: "external",
                name: "fixture/record",
                data: "equal facts",
                activity: {
                  kindLabel: "Opaque",
                  summary: {
                    kind: "fixture/permission",
                    noun: "permission",
                    plural: "permissions",
                  },
                  title: "Permission once",
                  layout: "row",
                  category: "record",
                  tone: "normal",
                  state: {
                    key: "once",
                    label: "Once",
                    facts: { active: false, terminal: true },
                  },
                },
              }],
            };
            messages.push(record);
            emit({ op: "message.upsert", message: record });
          }
          return null;
        }
        case "stop":
          await client.close();
          await app.stop();
          return null;
        default:
          throw new Error("Command outside running layout fixture");
      }
    },
  };
}
