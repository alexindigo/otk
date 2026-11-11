// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { start } from "../../main.ts";
import { staticResponse } from "../../core/mod.ts";
import { cfg } from "./config.ts";
import { browserProvider, browserScenarioPath } from "./browser-native.ts";
import { freePort } from "./opencode.ts";
import { resources, tempDir } from "./resources.ts";
import { SCALE } from "./session-scale.ts";
import { createScale, scaleDiscovery } from "./scale-native.ts";
import { consumerAssets } from "./consumer-builds.ts";
import { MESSAGE_CASES, PAYLOAD_BYTES } from "./message-scale-cases.ts";
import { nativeBinary, nativeKind, nativeVersion } from "./native.ts";
import { WsClient } from "./ws-client.ts";
import { scaleReadiness } from "./scale-readiness.ts";
import { scaleNativeEvidence } from "./scale-evidence.ts";
import { servingProbe } from "./serving-probe.ts";
import { waitFor } from "./opencode.ts";
import type { ControlRequest, Profile, TestLease } from "./fixture-control.ts";

/** Stock scale population plus the unchanged independent public UI consumer. */
export async function nativeScaleScenario(profile: Profile) {
  const root = await tempDir("scale-"), fake = browserProvider();
  const native = await createScale(join(root, "fixture"), root, fake, {
    messages: true,
    ...(profile === "contract-scale-heap" ? { payload: true } : {}),
  });
  scaleNativeEvidence(native);
  const readiness = await scaleReadiness(native);
  fake.strict();
  const a = native.manifest.sessions[0],
    b = native.manifest.sessions[MESSAGE_CASES.code];
  const reads: {
    at: number;
    before: boolean;
    cursor: string | null;
    ended?: number;
  }[] = [];
  const proxy = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const uri = new URL(request.url);
      if (
        browserScenarioPath({ kind: nativeKind }, uri.pathname) ===
          `/session/${a.nativeID}/message`
      ) {
        const row = {
          at: performance.now(),
          before: uri.searchParams.has("before") ||
            uri.searchParams.has("cursor"),
          cursor: uri.searchParams.get("before") ??
            uri.searchParams.get("cursor"),
          ended: undefined as number | undefined,
        };
        reads.push(row);
        if (profile === "contract-scale-scroll") {
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
        const response = await fetch(
          new Request(new URL(uri.pathname + uri.search, native.url), request),
        );
        row.ended = performance.now();
        return response;
      }
      return await fetch(
        new Request(new URL(uri.pathname + uri.search, native.url), request),
      );
    },
  );
  resources().defer("scale native proxy", () => proxy.shutdown());
  const assets = await consumerAssets("message-heap");
  const ui = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) =>
      staticResponse(new URL(request.url).pathname, { staticRoot: assets }),
  );
  resources().defer("scale public consumer", () => ui.shutdown());
  const uiURL = `http://127.0.0.1:${ui.addr.port}`;
  const config = cfg();
  config.auth.type = "none";
  config.server.port = freePort();
  config.server.origins = [uiURL];
  config.state.path = join(root, "state");
  config.harness.url = profile === "contract-scale-heap"
    ? native.url
    : `http://127.0.0.1:${proxy.addr.port}`;
  config.harness.db = native.db;
  await scaleDiscovery(native, config.harness.url);
  config.messages.coolms = 1000;
  const serving = servingProbe(false);
  resources().defer("scale serving measurements", () => serving.stop());
  const app = await start(config, {
    admission: serving.start,
    section: serving.section,
  });
  resources().defer("scale native application", () => app.stop());
  const pages: { at: number; before: boolean }[] = [];
  const read = app.backend.core.listMessages.bind(app.backend.core);
  app.backend.core.listMessages = (...args) => {
    if (args[0] === a.id) {
      pages.push({
        at: performance.now(),
        before: args[1].before !== undefined,
      });
    }
    return read(...args);
  };
  const client = new WsClient(`http://127.0.0.1:${config.server.port}`);
  await client.connect();
  resources().defer("scale client", () => client.close());
  if (profile !== "contract-scale-heap") {
    await waitFor(
      () => app.index.get(native.manifest.sessions.at(-1)!.id),
      Boolean,
      120000,
    );
    await client.wait(
      (frame) => frame.t === "harness" && frame.state === "connected",
      120000,
    );
  }
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  const url = new URL(uiURL);
  url.searchParams.set("api", `http://127.0.0.1:${config.server.port}`);
  url.searchParams.set("a", a.id);
  url.searchParams.set("b", b.id);
  url.searchParams.set("directory", a.directory);
  url.searchParams.set("oldest", "msg_scale000000000");
  if (profile !== "contract-scale-heap") url.searchParams.set("probe", "1");
  const info = {
    root,
    url: url.toString(),
    nativeUrl: native.url,
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [ui.addr.port, config.server.port, native.port, fake.port],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  let lease: TestLease | undefined;
  const gates = new Map<string, () => void>();
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      const p = frame.params;
      if (
        "lease" in p && p.lease !== undefined && p.lease !== lease?.lease
      ) throw new Error("Foreign native scale lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Scale already leased");
          lease = {
            lease: crypto.randomUUID(),
            directory: native.directory,
            baseline: {},
          };
          return lease;
        case "observe":
          return {
            readiness,
            a,
            b,
            pages,
            reads,
            serving: serving.samples,
            counts: native.manifest.counts,
            expectedCounts: SCALE,
            payloadBytes: PAYLOAD_BYTES,
            version: native.manifest.version,
          };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "nativeRequest":
          return await native.request(frame.params.path, {
            method: frame.params.method,
            body: frame.params.body,
          });
        case "queueScript": {
          const id = crypto.randomUUID();
          if (frame.params.gate !== "stepped") {
            throw new Error(
              "Scale stream requires stepped producer",
            );
          }
          const producer = fake.queueStepped({
            chunks: frame.params.chunks,
            delay: frame.params.delay ?? 0,
          });
          gates.set(id, () => producer.next());
          return { gate: id };
        }
        case "releaseGate": {
          const release = gates.get(frame.params.gate);
          if (!release) throw new Error("Unknown scale producer");
          release();
          return null;
        }
        case "scenario":
          if (frame.params.action !== "stop") {
            throw new Error(
              "Unknown scale action",
            );
          }
          serving.stop();
          serving.assert();
          return null;
        case "endTest":
          fake.releaseAll();
          await waitFor(() => fake.active, (count) => count === 0);
          if (fake.pending || fake.unexpected) {
            throw new Error("Native scale provider lease unsettled");
          }
          lease = undefined;
          return null;
        case "stop":
          await client.close();
          await app.stop();
          return null;
        default:
          throw new Error("Command outside native scale profile");
      }
    },
  };
}
