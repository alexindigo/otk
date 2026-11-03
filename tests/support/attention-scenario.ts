// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import type { PermissionRequest } from "@otk/protocol";
import { coreBackendFixture } from "./core-backend.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { fixture } from "./config.ts";
import { nativeFixture } from "./native-fixture.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { resources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import { FreezeProxy } from "./freeze-proxy.ts";
import { serve } from "./http.ts";
import { waitFor } from "./opencode.ts";
import { OtkDb, permissionMigrations, PermissionStore } from "@otk/store";
import { opencodeV1SessionID } from "@otk/harness-opencode-v1";
import type {
  ControlRequest,
  Json,
  Profile,
  TestLease,
} from "./fixture-control.ts";

/** The original external-backend scenes, with closed, fixture-owned controls. */
export async function attentionScenario(profile: Profile) {
  if (
    profile === "contract-attention-native" ||
    profile === "contract-attention-auto" ||
    profile === "contract-attention-remote"
  ) {
    return await nativeAttention(profile);
  }
  const root = await fixture(), id = "tstv1-core";
  const pending: PermissionRequest[] = Array.from({ length: 100 }, (_, n) => ({
    id: `ask-${n}`,
    sessionID: id,
    kind: "bash",
    title: "bash",
    patterns: [`printf item-${n}`],
    alwaysPatterns: [],
    time: 1,
    detail: { kind: "bash", command: `printf item-${n}` },
  }));
  const demand = profile === "contract-attention-demand";
  const f = demand
    ? await coreBackendFixture(root, {
      prompt: {
        prompt: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      },
      permissions: {
        listPermissions: () => Promise.resolve([...pending]),
        replyPermission: ({ requestID }) => {
          const at = pending.findIndex((r) => r.id === requestID);
          if (at < 0) {
            return Promise.reject(new Error("Request is no longer pending"));
          }
          pending.splice(at, 1);
          publish(requestID);
          return Promise.resolve();
        },
      },
    })
    : await inboxBrowserFixture(root);
  function publish(requestID?: string) {
    const entry = f.app.index.get(id)!;
    f.app.index.upsertMetadata({
      ...entry,
      status: pending.length ? "busy" : "idle",
      attention: { ...entry.attention, permissions: pending.length },
    });
    if (requestID) {
      f.app.connections.content(id, {
        op: "permission.remove",
        sessionID: id,
        requestID,
      });
    }
  }
  if (demand) publish();
  const c = new WsClient(f.url);
  await c.connect();
  resources().defer("attention control client", () => c.close());
  await c.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  await c.rpc("prefs.set", { key: "animationsOff", value: true });
  const entries = "entries" in f ? f.entries : [f.session];
  if (!demand && "add" in f) {
    for (
      const name of [
        "note",
        "running",
        "done",
        "blocked",
        "idle-tab",
        "green-tab",
        "amber-tab",
      ]
    ) {
      f.add({ ...f.entries[0], id: `tstv1-${name}`, title: name });
    }
  }
  const baseline = await c.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined, revision = 0;
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
      ) throw new Error("Foreign attention lease");
      switch (frame.command) {
        case "beginTest":
          lease = {
            lease: crypto.randomUUID(),
            directory: entries[0].directory,
            baseline,
          };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return {
            entries,
            pending: pending.length,
            requests: [],
            frames: c.frames,
          };
        case "productRpc":
          return await c.rpc(frame.params.method, frame.params.params);
        case "scenario": {
          const { action, sessionID } = frame.params;
          if (demand) {
            if (action !== "succeed") throw new Error("Unknown demand action");
            f.app.index.upsertMetadata({
              ...f.app.index.get(id)!,
              title: "Current Activity title",
            });
            return null;
          }
          if (!("update" in f)) throw new Error("No inbox scene");
          if (profile === "contract-attention-lights" && !sessionID) {
            f.app.connections.connection(
              action === "hold"
                ? "connecting"
                : action === "freeze"
                ? "reconnecting"
                : "connected",
            );
            return null;
          }
          if (
            profile === "contract-attention-digest" &&
            (action === "fail" || action === "succeed")
          ) {
            const rev = ++revision;
            f.app.index.applyDigest({
              id: "tstv1-note",
              revision: rev,
              summary: {
                state: "ready",
                revision: rev,
                messageCount: 1,
                total: {
                  calls: 1,
                  cost: .75,
                  tokens: {
                    input: 9,
                    output: 1,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                  contextPeak: 9,
                },
              },
              turns: { upsert: {}, remove: [] },
              deleted: action === "fail" ? { at: 3, how: "provider" } : null,
            });
          } else {
            if (!sessionID || !f.entries.some((e) => e.id === sessionID)) {
              throw new Error("Foreign inbox identity");
            }
            const entry = f.entries.find((e) => e.id === sessionID)!;
            if (action === "hold") f.update(sessionID, { status: "busy" });
            else if (action === "freeze") {
              f.update(sessionID, {
                attention: { ...entry.attention, permissions: 1 },
              });
            } else if (action === "release") {
              f.update(sessionID, {
                status: "idle",
                attention: { ...entry.attention, permissions: 0 },
              });
            } else throw new Error("Unknown inbox action");
          }
          return null;
        }
        case "stop":
          await c.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside attention scene");
      }
    },
  };
}

/** Real native stack(s), held reply and offline policy use the same original owners. */
async function nativeAttention(profile: Profile) {
  const f = await nativeFixture({ bash: "ask", edit: "ask", read: "ask" });
  f.fake.strict();
  const frozen = new FreezeProxy(f.oc.port);
  const held = Promise.withResolvers<void>();
  let holding = false, replying = false;
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (holding && /\/permission\/[^/]+\/reply$/.test(url.pathname)) {
        replying = true;
        await held.promise;
      }
      url.port = String(frozen.port);
      return await fetch(new Request(url, request));
    },
  );
  resources().defer("release attention proxy", () => {
    held.resolve();
    frozen.thaw();
  });
  resources().defer("stop attention proxy", () => proxy.shutdown());
  resources().defer("stop attention freeze proxy", () => frozen.stop());
  const server = await f.sidecar({
    harness: { url: `http://127.0.0.1:${proxy.addr.port}`, db: f.oc.db },
  });
  const remote = profile === "contract-attention-remote"
    ? await nativeFixture()
    : undefined;
  remote?.fake.strict();
  const other = await remote?.sidecar({ server: { origins: [server.url] } });
  const c = new WsClient(server.url);
  await c.connect();
  resources().defer("attention native control", () => c.close());
  await c.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  await c.rpc("prefs.set", { key: "animationsOff", value: true });
  const baseline = await c.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined;
  const info = {
    root: f.oc.root,
    url: server.url,
    nativeUrl: f.oc.url,
    binary: nativeBinary,
    version: nativeVersion,
    pids: [
      Deno.pid,
      f.oc.process.pid!,
      server.process.pid!,
      ...(remote ? [remote.oc.process.pid!, other!.process.pid!] : []),
    ],
    ports: [
      f.fake.port,
      f.oc.port,
      f.oc.nativePort,
      server.port,
      frozen.port,
      proxy.addr.port,
      ...(remote
        ? [remote.fake.port, remote.oc.port, remote.oc.nativePort, other!.port]
        : []),
    ],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  const files = async (directory: string) => {
    const values: Record<string, string | null> = {};
    for (
      const name of [
        "README.md",
        "quiet-auto.txt",
        "other-auto.txt",
        "browser-auto.txt",
        "guarded-auto.txt",
        "manual-ui.txt",
        "permission-details.txt",
        "notification-result.txt",
      ]
    ) {
      values[name] = await Deno.readTextFile(join(directory, name)).catch(
        (e) => {
          if (e instanceof Deno.errors.NotFound) return null;
          throw e;
        },
      );
    }
    return values;
  };
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign native attention lease");
      switch (frame.command) {
        case "beginTest":
          lease = {
            lease: crypto.randomUUID(),
            directory: f.oc.directory,
            baseline,
          };
          return lease;
        case "endTest":
          held.resolve();
          frozen.thaw();
          for (const owner of [f, ...(remote ? [remote] : [])]) {
            owner.fake.releaseAll();
            await waitFor(
              () => owner.fake.active + owner.fake.pending,
              (n) => n === 0,
            );
            if (owner.fake.pending || owner.fake.unexpected) {
              throw new Error("Unsettled attention provider lease");
            }
          }
          lease = undefined;
          return null;
        case "nativeRequest": {
          const p = frame.params, owner = p.target === "remote" ? remote : f;
          if (!owner) throw new Error("No remote owner");
          if (p.path.endsWith("/children")) {
            return await owner.oc.sessionList(p.path);
          }
          return p.path === "/session" && p.method === "POST"
            ? await owner.oc.session(p.path, { method: "POST", body: p.body })
            : await owner.oc.request(p.path, {
              method: p.method,
              body: p.body,
            });
        }
        case "queueScript": {
          const p = frame.params, owner = p.target === "remote" ? remote : f;
          if (!owner || p.gate) {
            throw new Error("Unsupported provider target/gate");
          }
          owner.fake.queue({
            chunks: p.chunks,
            ...(p.tool ? { tool: p.tool } : {}),
          });
          return {};
        }
        case "productRpc":
          return await c.rpc(frame.params.method, frame.params.params);
        case "observe":
          return {
            requests: f.fake.requests,
            frames: c.frames,
            replying,
            files: await files(f.oc.directory),
            remoteFiles: remote ? await files(remote.oc.directory) : null,
            remoteUrl: other?.url,
            remoteDirectory: remote?.oc.directory,
          };
        case "scenario":
          if (frame.params.action === "hold") holding = true;
          else if (frame.params.action === "release") {
            holding = false;
            held.resolve();
          } else if (frame.params.action === "freeze") frozen.freeze();
          else if (frame.params.action === "thaw") frozen.thaw();
          else if (frame.params.action === "fail" && frame.params.sessionID) {
            const session = frame.params.sessionID.startsWith("opcv1-")
              ? frame.params.sessionID
              : opencodeV1SessionID.encode(frame.params.sessionID);
            await c.rpc("permission.activity", { sessionID: session });
            const db = new OtkDb(join(f.oc.root, `otk-${server.port}`), [
              permissionMigrations,
            ], { busyms: 5000 });
            try {
              const records = new PermissionStore(db);
              for (
                const [id, error] of [[
                  "failed-display-fixture",
                  "Stored failure fixture",
                ], ["unconfirmed-display-fixture", undefined]] as const
              ) {
                const request: PermissionRequest = {
                  id,
                  sessionID: session,
                  kind: "bash",
                  title: "bash",
                  patterns: [`printf ${id}`],
                  alwaysPatterns: [],
                  time: Date.now(),
                  detail: { kind: "bash", command: `printf ${id}` },
                };
                const record = records.start({
                  session,
                  requestID: id,
                  request: JSON.stringify(request),
                  reply: "once",
                  source: "auto",
                  owner: session,
                });
                if (error) records.finish(record, { outcome: "failed", error });
              }
            } finally {
              db.close();
            }
          } else throw new Error("Unknown native attention action");
          return null;
        case "stop":
          held.resolve();
          frozen.thaw();
          await c.close();
          await remote?.stop();
          await f.stop();
          return null;
        default:
          throw new Error("Command outside native attention scene");
      }
    },
  };
}
