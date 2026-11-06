// SPDX-License-Identifier: LGPL-3.0-only
import { fixture } from "./config.ts";
import { publicUiScenario } from "./public-ui-scenario.ts";
import { requestScaleFixture } from "./request-scale.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { resources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import { SCALE } from "./session-scale.ts";
import { nativeScaleScenario } from "./native-scale-scenario.ts";
import { coreBackendFixture } from "./core-backend.ts";
import { scaleReadiness } from "./scale-readiness.ts";
import { scaleNativeEvidence } from "./scale-evidence.ts";
import { populationScaleScenario } from "./population-scale-scenario.ts";
import { Tasks } from "@otk/store";
import type { ControlRequest, Profile, TestLease } from "./fixture-control.ts";

/** Private isolated scale compositions; browser input stays in Playwright. */
export async function scaleScenario(profile: Profile) {
  if (
    ["contract-scale-paint", "contract-scale-sessions", "contract-scale-files"]
      .includes(profile)
  ) return await populationScaleScenario(profile);
  if (
    ["contract-scale-heap", "contract-scale-runtime", "contract-scale-scroll"]
      .includes(profile)
  ) return await nativeScaleScenario(profile);
  if (profile === "contract-scale-remaining") {
    return await publicUiScenario("remaining");
  }
  const root = await fixture();
  const sections: { name: string; ms: number }[] = [];
  const core = profile === "contract-scale-core"
    ? await coreBackendFixture(root, {}, "tstv1-core", {
      diagnostics: (name, ms) => sections.push({ name, ms }),
    })
    : undefined;
  const request = profile === "contract-scale-request"
    ? await requestScaleFixture()
    : undefined;
  const ids: string[] = [], tasks: string[] = [];
  const inbox = request || core ? undefined : await inboxBrowserFixture(
    root,
    [],
    {},
    undefined,
    (store, entries) => {
      // This fixed population qualifies overflow, not task-creation RPCs. Seed
      // it once before the application subscribes, as other scale fixtures do.
      const owner = new Tasks(store), base = entries[0];
      store.write((tx) => {
        for (let n = 0; n < 300; n++) {
          const id = `tstv1-task-${n}`;
          ids.push(id);
          entries.push({ ...base, id, title: `Session ${n}` });
          tasks.push(
            owner.create(base.directory, `Qualification task ${n}`, [id], tx)
              .id,
          );
        }
      });
    },
  );
  const f = request ?? core ?? inbox!;
  if (request) scaleNativeEvidence(request.native);
  const readiness = request ? await scaleReadiness(request.native) : [];
  const client = new WsClient(f.url);
  await client.connect();
  resources().defer("scale control client", () => client.close());
  const held = Promise.withResolvers<void>();
  resources().defer("scale request gate", () => held.resolve());
  let effects = 0;
  if (request) {
    const registry = request.app.requests.options.registry,
      prepare = registry.prepare.bind(registry);
    registry.prepare = (method, params) => {
      const prepared = prepare(method, params);
      return method === "tasks.create"
        ? {
          ...prepared,
          run: async (...args) => {
            effects++;
            await held.promise;
            return await prepared.run(...args);
          },
        }
        : prepared;
    };
  } else if (inbox) {
    await client.rpc("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
  }
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  const info = {
    root: request?.root ?? root,
    url: f.url,
    nativeUrl: request?.native.url ?? "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [Number(new URL(f.url).port)],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  let lease: TestLease | undefined;
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      const p = frame.params;
      if (
        "lease" in p && p.lease !== undefined && p.lease !== lease?.lease
      ) throw new Error("Foreign scale lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Scale already leased");
          lease = {
            lease: crypto.randomUUID(),
            directory: request?.native.directory ??
              inbox?.entries[0].directory ?? root,
            baseline: {},
          };
          return lease;
        case "observe":
          return {
            readiness,
            sections,
            effects,
            ids,
            tasks,
            sessionID: request?.native.manifest.sessions[0].id,
            counts: request?.native.manifest.counts ?? null,
            expectedCounts: SCALE,
            samples: request?.probe.samples ?? [],
          };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "scenario":
          if (frame.params.action === "hold" && core) {
            sections.length = 0;
            const start = performance.now();
            for (let n = 0; n < 40; n++) {
              core.app.connections.connection(
                n % 2 ? "connected" : "reconnecting",
              );
            }
            return { synchronousMs: performance.now() - start, sections };
          }
          if (frame.params.action === "release") held.resolve();
          else if (frame.params.action === "hold" && inbox) {
            inbox.update(ids[240], { status: "busy" });
            inbox.update(ids[241], {
              attention: { ...inbox.entries[0].attention, permissions: 1 },
            });
            inbox.update(ids[242], { status: "busy" });
          } else if (frame.params.action === "succeed" && inbox) {
            inbox.update(
              ids[242],
              { status: "idle" },
            );
          } else if (frame.params.action === "thaw" && inbox) {
            for (const id of ids) inbox.update(id, { status: "busy" });
          } else if (frame.params.action === "freeze" && inbox) {
            for (
              let n = 200;
              n < 220;
              n++
            ) inbox.update(ids[n], { status: "busy" });
          } else {throw new Error(
              "Action outside scale profile",
            );}
          return null;
        case "endTest":
          lease = undefined;
          held.resolve();
          return null;
        case "stop":
          held.resolve();
          await client.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside scale profile");
      }
    },
  };
}
