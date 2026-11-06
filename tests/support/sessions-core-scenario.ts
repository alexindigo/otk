// SPDX-License-Identifier: LGPL-3.0-only
import { coreBackendFixture } from "./core-backend.ts";
import { fixture } from "./config.ts";
import { resources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type {
  ControlRequest,
  Json,
  Profile,
  TestLease,
} from "./fixture-control.ts";

export async function sessionsCoreScenario(profile: Profile) {
  const root = await fixture();
  const unknown = profile === "contract-sessions-unknown";
  const f = await coreBackendFixture(
    root,
    unknown
      ? {
        usage: {
          getUsage: () =>
            Promise.reject(
              new Error("Detailed usage is unavailable for unreported headers"),
            ),
        },
      }
      : {},
  );
  let reads = 0;
  const held = Promise.withResolvers<void>();
  resources().defer("sessions held initial transcript", () => held.resolve());
  if (profile === "contract-sessions-direct") {
    const read = f.app.backend.core.listMessages;
    f.app.backend.core.listMessages = async (...args) => {
      reads++;
      await held.promise;
      return await read(...args);
    };
  }
  if (unknown || profile === "contract-sessions-summary") {
    f.app.backend.core.listMessages = () =>
      Promise.resolve(f.page([{
        id: "reply",
        sessionID: f.session.id,
        role: "assistant",
        replyTo: "turn",
        agent: "build",
        model: { provider: "test", model: "test" },
        time: { created: 1, completed: 2 },
        tokens: {
          input: unknown ? 0 : 2,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: unknown ? 0 : .25,
        interrupted: false,
        parts: [],
      }]));
    const total = {
      calls: 1,
      cost: unknown ? null : .25,
      tokens: {
        input: unknown ? null : 2,
        output: unknown ? 2 : 0,
        reasoning: unknown ? 3 : 0,
        cache: { read: unknown ? 4 : 0, write: unknown ? 5 : 0 },
      },
      contextPeak: unknown ? null : 2,
    };
    f.app.index.applyDigest({
      id: f.session.id,
      revision: 1,
      summary: { state: "ready", revision: 1, total },
      turns: { upsert: { turn: total }, remove: [] },
      deleted: null,
    });
  }
  const c = new WsClient(f.url);
  await c.connect(root);
  resources().defer("sessions core client", () => c.close());
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
      ) throw new Error("Foreign sessions core lease");
      switch (frame.command) {
        case "beginTest":
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          held.resolve();
          lease = undefined;
          return null;
        case "observe":
          return { session: f.session, reads, frames: c.frames, requests: [] };
        case "productRpc":
          return await c.rpc(frame.params.method, frame.params.params);
        case "scenario": {
          const { action } = frame.params;
          if (profile === "contract-sessions-direct" && action === "release") {
            held.resolve();
            return null;
          }
          if (profile !== "contract-sessions-resurrection") {
            throw new Error(
              "No digest control in this profile",
            );
          }
          if (action === "hold") {
            f.app.index.applyDigest({
              id: f.session.id,
              revision: 1,
              summary: { state: "digesting", revision: 1 },
              turns: { upsert: {}, remove: [] },
              deleted: { at: 1, how: "provider" },
            });
          } else if (action === "release") {
            f.app.index.applyDigest({
              id: f.session.id,
              revision: 2,
              summary: { state: "ready", revision: 2 },
              turns: { upsert: {}, remove: [] },
              deleted: null,
            });
          } else throw new Error("Unknown digest action");
          return null;
        }
        case "stop":
          held.resolve();
          await c.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside sessions core scenario");
      }
    },
  };
}
