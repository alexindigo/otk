// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { coreBackendFixture } from "./core-backend.ts";
import { cfg, fixture } from "./config.ts";
import { WsClient } from "./ws-client.ts";
import { resources } from "./resources.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { mapMessage, OpencodeV1Adapter } from "@otk/harness-opencode-v1";
import type { Capabilities } from "@otk/harness";
import type { ModelCatalog, PromptInput } from "@otk/protocol";
import type {
  ControlRequest,
  Json,
  Profile,
  TestLease,
} from "./fixture-control.ts";

export async function composerContractScenario(profile: Profile) {
  const root = await fixture(), sent: PromptInput[] = [];
  let calls = 0;
  const pending = Promise.withResolvers<ModelCatalog>();
  const catalog: ModelCatalog = {
    defaultState: "unknown",
    providers: [{
      id: "connected",
      name: "Connected provider",
      models: [{
        id: "available",
        name: "Available model",
        variants: [],
        status: "active",
        free: false,
      }],
    }],
  };
  const capabilities: Capabilities = {};
  let native: OpencodeV1Adapter | undefined;
  if (profile !== "contract-composer-none") {
    capabilities.prompt = {
      prompt: (input) => {
        sent.push(input);
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
    };
    capabilities.models = {
      listModels: () => {
        calls++;
        if (profile === "contract-composer-failed-variant") {
          return Promise.reject(new Error("Catalog offline"));
        }
        if (profile === "contract-composer-missing") {
          return calls === 1
            ? pending.promise
            : calls === 3
            ? Promise.reject(new Error("Refresh failed"))
            : Promise.resolve(catalog);
        }
        return pending.promise;
      },
    };
  }
  if (profile === "contract-composer-pending-choice") {
    capabilities.agents = {
      listAgents: () =>
        Promise.resolve([{ name: "build" }, {
          name: "review",
          model: { provider: "later", model: "choice" },
          variant: "high",
        }]),
    };
  }
  if (profile === "contract-composer-native-null") {
    const settings = cfg();
    settings.harness.db = join(root, "absent.db");
    native = new OpencodeV1Adapter(
      settings,
      undefined,
      (input) =>
        Promise.resolve(
          Response.json(
            new URL(String(input)).pathname === "/agent"
              ? [{
                name: "build",
                mode: "primary",
                description: null,
                color: null,
                model: null,
                variant: null,
              }]
              : { directory: root },
          ),
        ),
    );
    capabilities.agents = native.capabilities.agents;
    resources().defer(
      "composer native null adapter",
      () => native!.core.stop(),
    );
  }
  const id = profile === "contract-composer-native-null"
    ? "opcv1-core"
    : "tstv1-core";
  const f = await coreBackendFixture(root, capabilities, id);
  if (
    ["contract-composer-missing", "contract-composer-failed-variant"].includes(
      profile,
    )
  ) {
    const list = f.app.backend.core.listMessages;
    f.app.backend.core.listMessages = async (...args) => {
      const page = await list(...args);
      const fields = profile === "contract-composer-missing"
        ? {
          model: { provider: "disconnected", model: "restored-model" },
          agent: "build",
        }
        : {
          agent: "review",
          model: { provider: "offline", model: "restored" },
          variant: "high",
        };
      return {
        ...page,
        prompt: page.prompt && { ...page.prompt, ...fields },
        items: page.items.map((message) =>
          message.role === "user" ? { ...message, ...fields } : message
        ),
      };
    };
  }
  if (profile === "contract-composer-native-null") {
    f.app.backend.core.listMessages = () =>
      Promise.resolve(
        f.page([
          mapMessage(
            JSON.parse(
              JSON.stringify({
                id: "restored",
                sessionID: "core",
                role: "user",
                time: { created: 1 },
                agent: "build",
                model: null,
              }),
            ),
          ),
        ]),
      );
  }
  resources().defer(
    "composer catalog pending lifetime",
    () => pending.resolve({ providers: [], defaultState: "unknown" }),
  );
  const client = new WsClient(f.url);
  await client.connect(root);
  resources().defer("composer contract client", () => client.close());
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
      ) throw new Error("Foreign composer contract lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Composer contract already leased");
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          pending.resolve({ providers: [], defaultState: "unknown" });
          lease = undefined;
          return null;
        case "observe":
          return { sent, calls, frames: client.frames, sessionID: id };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "scenario":
          if (frame.params.action === "fail") {
            pending.reject(
              new Error("Catalog temporarily unreachable"),
            );
          } else if (frame.params.action === "release") {
            pending.resolve(
              profile === "contract-composer-native-null"
                ? {
                  defaultState: "configured",
                  default: { provider: "fixture", model: "plain" },
                  providers: [{
                    id: "fixture",
                    name: "Fixture provider",
                    models: [{
                      id: "plain",
                      name: "Plain model",
                      variants: [],
                      status: "active",
                      free: false,
                    }],
                  }],
                }
                : {
                  defaultState: "unknown",
                  providers: [{
                    id: "later",
                    name: "Later",
                    models: [{
                      id: "choice",
                      name: "Ready choice",
                      variants: ["high"],
                      status: "active",
                      free: false,
                    }],
                  }],
                },
            );
          } else throw new Error("Unknown composer catalog action");
          return null;
        case "stop":
          pending.resolve({ providers: [], defaultState: "unknown" });
          await client.close();
          await f.app.stop();
          await native?.core.stop();
          return null;
        default:
          throw new Error("Command outside composer contract");
      }
    },
  };
}
