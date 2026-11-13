// SPDX-License-Identifier: LGPL-3.0-only
import type { Capabilities } from "@otk/harness";
import type { PermissionReply, PromptInput } from "@otk/protocol";
import { fixture } from "./config.ts";
import { coreBackendFixture } from "./core-backend.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { consumerAssets } from "./consumer-builds.ts";
import { publicUiScenario } from "./public-ui-scenario.ts";
import { menusMessages } from "./menus-data.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { resources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import type {
  ControlRequest,
  Json,
  Profile,
  TestLease,
} from "./fixture-control.ts";

/** Closed external-backend scenes preserve the original absent-capability contracts. */
export async function menusScenario(profile: Profile) {
  if (profile === "contract-menus-dialog") {
    return await publicUiScenario("dialog");
  }
  const root = await fixture(),
    sends: PromptInput[] = [],
    replies: PermissionReply[] = [],
    answers: unknown[] = [];
  let aborts = 0;
  // The external harness owns explicit run evidence, not a status-to-lamp fallback.
  const work = (keys: string[]) => {
    f.app.index.upsert({
      ...f.app.index.get("tstv1-core")!,
      status: keys.length ? "busy" : "idle",
      activity: { work: { keys, fresh: true } },
    });
  };
  const capabilities: Capabilities = {};
  if (profile === "contract-menus-hints") {
    capabilities.prompt = {
      prompt: (input) => {
        sends.push(input);
        return Promise.resolve();
      },
      abort: () => {
        aborts++;
        work([]);
        return Promise.resolve();
      },
    };
  }
  if (profile === "contract-menus-permission") {
    capabilities.permissions = {
      listPermissions: () =>
        Promise.resolve([{
          id: "permission",
          sessionID: "tstv1-core",
          kind: "bash",
          title: "Probe",
          time: 1,
          detail: { kind: "bash", command: "true" },
          patterns: ["true"],
          alwaysPatterns: ["true"],
        }]),
      replyPermission: (input) => {
        replies.push(input);
        return Promise.resolve();
      },
    };
  }
  if (profile === "contract-menus-question") {
    capabilities.questions = {
      listQuestions: () =>
        Promise.resolve([{
          id: "question",
          sessionID: "tstv1-core",
          questions: [{
            header: "Choice",
            text: "Choose one",
            multiple: false,
            custom: true,
            options: [{ label: "Option", description: "A choice" }],
          }],
        }]),
      answerQuestion: (_id, value) => {
        answers.push(value ?? null);
        return Promise.resolve();
      },
    };
  }
  const core = [
    "contract-menus-hints",
    "contract-menus-permission",
    "contract-menus-question",
  ].includes(profile);
  const f = core
    ? await coreBackendFixture(root, capabilities)
    : await inboxBrowserFixture(
      root,
      [],
      profile === "contract-menus-content"
        ? { "tstv1-otk": menusMessages }
        : {},
      profile === "contract-menus-context"
        ? await consumerAssets("context")
        : undefined,
    );
  if ("add" in f) {
    f.add({ ...f.entries[0], id: "tstv1-second", title: "Second session" });
    for (let n = 1; n < 10; n++) {
      f.add({
        ...f.entries[0],
        id: `tstv1-r2-session-${n}`,
        title: `Menu session ${n}`,
      });
    }
  }
  const c = new WsClient(f.url);
  await c.connect(
    "entries" in f ? f.entries[0].directory : root,
    "entries" in f ? f.entries[0].id : f.session.id,
  );
  resources().defer("menus control client", () => c.close());
  await c.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  const baseline = await c.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined;
  const info = {
    root,
    url: f.url,
    nativeUrl: "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [Number(new URL(f.url).port)],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign menus lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Menus scene already leased");
          lease = {
            lease: crypto.randomUUID(),
            directory: "entries" in f ? f.entries[0].directory : root,
            baseline,
          };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return {
            sends,
            aborts,
            replies,
            answers,
            entries: "entries" in f ? f.entries : [],
            frames: c.frames,
          };
        case "productRpc":
          return await c.rpc(frame.params.method, frame.params.params);
        case "scenario":
          if (
            profile === "contract-menus-hints" && frame.params.action === "hold"
          ) {
            work(["shortcut-held-run"]);
          } else if (
            "update" in f && frame.params.action === "hold" &&
            frame.params.sessionID === "tstv1-second"
          ) f.update("tstv1-second", { status: "busy" });
          else if (
            "entries" in f && ["freeze", "thaw"].includes(frame.params.action)
          ) {
            f.app.connections.connection(
              frame.params.action === "freeze" ? "reconnecting" : "connected",
            );
          } else throw new Error("Unknown menus scenario action");
          return null;
        case "stop":
          await c.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside menus scene");
      }
    },
  };
}
