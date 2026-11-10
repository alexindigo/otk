// SPDX-License-Identifier: LGPL-3.0-only
import { coreBackendFixture } from "./core-backend.ts";
import { typedFormScenario } from "./typed-form-scenario.ts";
import { messagesScenario } from "./messages-scenario.ts";
import { composerContractScenario } from "./composer-contract-scenario.ts";
import { sessionsScenario } from "./sessions-scenario.ts";
import { attentionScenario } from "./attention-scenario.ts";
import { menusScenario } from "./menus-scenario.ts";
import { publicUiScenario } from "./public-ui-scenario.ts";
import { visualScenario } from "./visual-scenario.ts";
import { themeScenario } from "./theme-scenario.ts";
import { loadPriorityScenario } from "./load-priority-scenario.ts";
import { loadPopulationScenario } from "./load-population-scenario.ts";
import { scaleScenario } from "./scale-scenario.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { fixture } from "./config.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { resources } from "./resources.ts";
import {
  OperationFailure,
  type PermissionRequest,
  type QuestionRequest,
} from "@otk/protocol";
import type { Capabilities } from "@otk/harness";
import type {
  ControlRequest,
  Json,
  Profile,
  TestLease,
} from "./fixture-control.ts";

/** Checked external-backend compositions: no native stack for absent-capability proofs. */
export async function contractScenario(profile: Profile) {
  if (profile === "contract-typed-forms") return await typedFormScenario();
  if (profile === "contract-load-priority") return await loadPriorityScenario();
  if (profile === "contract-load-small" || profile === "contract-load-large") {
    return await loadPopulationScenario(profile === "contract-load-large");
  }
  if (profile === "contract-themes") return await themeScenario();
  if (profile.startsWith("contract-scale-")) {
    return await scaleScenario(profile);
  }
  if (profile === "contract-visual-inbox") return await visualScenario();
  if (profile === "contract-visual-styles") {
    return await publicUiScenario("styles");
  }
  if (profile === "contract-visual-provider-ports") {
    return await publicUiScenario("provider-ports");
  }
  if (profile === "contract-visual-native-events") {
    return await publicUiScenario("native-events");
  }
  if (profile.startsWith("contract-menus-")) {
    return await menusScenario(profile);
  }
  if (profile.startsWith("contract-attention-")) {
    return await attentionScenario(profile);
  }
  if (profile.startsWith("contract-sessions-")) {
    return await sessionsScenario(profile);
  }
  if (profile.startsWith("contract-composer-")) {
    return await composerContractScenario(profile);
  }
  if (profile.startsWith("contract-messages-")) {
    return await messagesScenario(profile);
  }
  const root = await fixture();
  const sessionID = "tstv1-core";
  let held = Promise.withResolvers<void>(),
    calls = 0,
    done = false,
    fail = true,
    stopped = false;
  const permission: PermissionRequest = {
    id: "permission-proof",
    sessionID,
    kind: "bash",
    title: "Run the proof",
    patterns: ["echo proof"],
    alwaysPatterns: ["echo *"],
    detail: { kind: "bash", command: "echo proof" },
    time: 1,
  };
  const question: QuestionRequest = {
    id: "question-proof",
    sessionID,
    questions: [{
      text: "Which result?",
      options: [{ label: "One" }],
      custom: true,
      multiple: false,
    }],
  };
  const capabilities: Capabilities = {};
  const reply = async () => {
    calls++;
    await held.promise;
    if (fail) {
      throw new OperationFailure(
        "rejected",
        "request.params",
        new Error("private SQL /secret/path"),
      );
    }
    done = true;
    f.app.connections.content(sessionID, {
      op: profile === "contract-permission-feedback"
        ? "permission.remove"
        : "question.remove",
      sessionID,
      requestID: profile === "contract-permission-feedback"
        ? permission.id
        : question.id,
    });
  };
  if (
    profile === "contract-reconnect" ||
    profile === "contract-permission-feedback"
  ) {
    capabilities.permissions = {
      listPermissions: () => Promise.resolve(done ? [] : [permission]),
      replyPermission: reply,
    };
  }
  if (
    profile === "contract-reconnect" || profile === "contract-question-feedback"
  ) {
    capabilities.questions = {
      listQuestions: () => Promise.resolve(done ? [] : [question]),
      answerQuestion: reply,
    };
  }
  if (profile === "contract-initial-question") {
    capabilities.questions = {
      listQuestions: () =>
        Promise.resolve([{
          id: "initial-question",
          sessionID,
          questions: [{
            text: "Initial question",
            options: [],
            multiple: false,
            custom: true,
          }],
        }]),
      answerQuestion: (requestID) => {
        calls++;
        f.app.connections.content(sessionID, {
          op: "question.remove",
          requestID,
          sessionID,
        });
        return Promise.resolve();
      },
    };
    capabilities.prompt = {
      prompt: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    };
  }
  const inbox = profile === "contract-task-background" ||
    profile === "contract-rpc";
  const f = inbox
    ? await inboxBrowserFixture(root)
    : await coreBackendFixture(root, capabilities);
  resources().defer("release contract scenario", () => {
    held.resolve();
  });
  if (
    profile === "contract-task-background" ||
    profile === "contract-task-pending"
  ) {
    const registry = f.app.requests.options.registry,
      prepare = registry.prepare.bind(registry);
    registry.prepare = (method, params) => {
      const prepared = prepare(method, params);
      return method === "tasks.create"
        ? {
          ...prepared,
          run: async (...args) => {
            calls++;
            await held.promise;
            return await prepared.run(...args);
          },
        }
        : prepared;
    };
  }
  const client = new WsClient(f.url);
  await client.connect(
    "entries" in f ? f.entries[0].directory : root,
    "entries" in f ? f.entries[0].id : f.session.id,
  );
  resources().defer("contract control client", () => client.close());
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  const baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined;
  const info = {
    root,
    url: f.url,
    nativeUrl: "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [new URL(f.url).port].map(Number),
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      const p = frame.params;
      if ("lease" in p && p.lease !== undefined && p.lease !== lease?.lease) {
        throw new Error("Foreign contract lease");
      }
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Contract already leased");
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          held.resolve();
          return null;
        case "observe":
          return {
            calls,
            done,
            stopped,
            frames: client.frames,
            entries: "entries" in f ? f.entries : [],
            requests: [],
          };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "scenario":
          if (frame.params.action === "release") held.resolve();
          else if (frame.params.action === "succeed") {
            fail = false;
            held = Promise.withResolvers<void>();
          } else if (frame.params.action === "stop") {
            await client.close();
            await f.app.stop();
            stopped = true;
          } else throw new Error("Action outside contract scenario");
          return null;
        case "stop":
          held.resolve();
          await client.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside contract scenario");
      }
    },
  };
}
