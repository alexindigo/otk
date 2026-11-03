// SPDX-License-Identifier: LGPL-3.0-only
import { join, relative, resolve } from "@std/path";
import { start } from "../../main.ts";
import { OtkDb } from "@otk/store";
import { cfg } from "./config.ts";
import { beta2Migrations } from "./beta1-state.ts";
import { FakeLlm } from "./fake-llm.ts";
import { freePort, waitFor } from "./opencode.ts";
import { resources, tempDir } from "./resources.ts";
import { SCALE, SessionScale } from "./session-scale.ts";
import { remainingFiles } from "./remaining-measurements.ts";
import { observeCatalogWatches } from "./remaining-generations.ts";
import { servingProbe } from "./serving-probe.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { WsClient } from "./ws-client.ts";
import { scaleReadiness } from "./scale-readiness.ts";
import { scaleNativeEvidence } from "./scale-evidence.ts";
import { sessionFamily, usageCost } from "@otk/client";
import type { OpencodeV1Adapter } from "@otk/harness-opencode-v1";
import type { ControlRequest, Profile, TestLease } from "./fixture-control.ts";

/** One stock population per isolated qualification; no browser transport here. */
export async function populationScaleScenario(profile: Profile) {
  const root = await tempDir("population-"), fake = new FakeLlm();
  const native = await SessionScale.create(
    join(root, "fixture"),
    root,
    fake,
    profile === "contract-scale-files" ? { files: true } : {},
  );
  scaleNativeEvidence(native);
  const readiness = await scaleReadiness(native);
  fake.strict();
  const nativeReads: unknown[] = [];
  const proxy = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const uri = new URL(request.url),
        row = {
          path: uri.pathname,
          query: uri.search,
          at: performance.now(),
          headers: undefined as number | undefined,
          end: undefined as number | undefined,
          status: undefined as number | undefined,
        };
      nativeReads.push(row);
      const response = await fetch(
        new Request(new URL(uri.pathname + uri.search, native.url), request),
      );
      row.headers = performance.now();
      row.status = response.status;
      if (uri.pathname.endsWith("/event")) return response;
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      const body = await response.arrayBuffer();
      row.end = performance.now();
      return new Response(body, { status: response.status, headers });
    },
  );
  resources().defer("population native observation", () => proxy.shutdown());
  const config = cfg();
  config.auth.type = "none";
  config.server.port = freePort();
  config.state.path = join(root, "state");
  config.harness.url = profile === "contract-scale-paint"
    ? `http://127.0.0.1:${proxy.addr.port}`
    : native.url;
  config.harness.db = native.db;
  let files: string[] = [];
  if (profile === "contract-scale-files") {
    files = await remainingFiles(native.directory);
    const db = new OtkDb(config.state.path, beta2Migrations, config.storage);
    db.transaction(() => {
      const task = db.connection.prepare("INSERT INTO tasks VALUES(?,?,?,?)"),
        member = db.connection.prepare(
          "INSERT INTO task_sessions VALUES(?,?,0)",
        );
      for (let n = 0; n < SCALE.projectSessions; n++) {
        task.run(
          `scale-task-${n}`,
          native.directory,
          `Qualification task ${n}`,
          n,
        );
        member.run(`scale-task-${n}`, native.manifest.sessions[n].id);
      }
    });
    db.close();
  }
  const serving = servingProbe(false),
    phases: unknown[] = [],
    sections: unknown[] = [];
  resources().defer("population serving observation", () => serving.stop());
  const app = await start(config, {
    admission: serving.start,
    section: (name, ms) => {
      serving.section(name, ms);
      sections.push({ at: performance.now(), name, ms });
    },
  });
  resources().defer("population application", () => app.stop());
  const ready = new Set<string>(), nativeEvents: unknown[] = [];
  for (const entry of app.index.values()) {
    if (entry.digest.state === "ready") ready.add(entry.id);
  }
  resources().defer(
    "population index observer",
    app.index.observe((entry, previous) => {
      if (entry.digest.state === "ready") ready.add(entry.id);
      else ready.delete(entry.id);
      if (
        previous &&
        (previous.status !== entry.status ||
          JSON.stringify(previous.attention) !==
            JSON.stringify(entry.attention))
      ) {
        nativeEvents.push({
          id: entry.id,
          status: entry.status,
          attention: entry.attention.permissions + entry.attention.questions +
            entry.attention.childPermissions + entry.attention.childQuestions,
          wall: Date.now(),
        });
      }
    }),
  );
  const pages = app.backend.core.listMessages.bind(app.backend.core);
  app.backend.core.listMessages = (...args) => {
    const row = {
      kind: "page",
      sessionID: args[0],
      before: args[1].before,
      at: performance.now(),
      end: undefined as number | undefined,
      error: undefined as string | undefined,
    };
    phases.push(row);
    return pages(...args).then((value) => {
      row.end = performance.now();
      return value;
    }, (error) => {
      row.end = performance.now();
      row.error = String(error);
      throw error;
    });
  };
  const digest = (app.backend as OpencodeV1Adapter).digest!,
    metadata = digest.transcriptMetadata.bind(digest);
  digest.transcriptMetadata = (...args) => {
    const row = {
      kind: "metadata",
      sessionID: args[0],
      at: performance.now(),
      end: undefined as number | undefined,
      error: undefined as string | undefined,
    };
    phases.push(row);
    return metadata(...args).then((value) => {
      row.end = performance.now();
      return value;
    }, (error) => {
      row.end = performance.now();
      row.error = String(error);
      throw error;
    });
  };
  const watches = observeCatalogWatches(app.backend);
  resources().defer("population watch observation", () => watches.restore());
  const client = new WsClient(`http://127.0.0.1:${config.server.port}`);
  await client.connect();
  resources().defer("population client", () => client.close());
  await waitFor(
    () => app.index.get(native.manifest.sessions.at(-1)!.id),
    Boolean,
    120000,
  );
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  if (profile === "contract-scale-paint") {
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await client.rpc("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
    const landing = native.manifest.sessions[251];
    await client.rpc("tasks.create", {
      directory: landing.directory,
      name: "Paint measurement landing",
      sessions: [landing.id],
    });
  }
  const gates = new Map<string, () => void>();
  const info = {
    root,
    url: `http://127.0.0.1:${config.server.port}`,
    nativeUrl: native.url,
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [config.server.port, native.port, fake.port, proxy.addr.port],
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
      ) throw new Error("Foreign population lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Population already leased");
          lease = {
            lease: crypto.randomUUID(),
            directory: native.directory,
            baseline: {},
          };
          return lease;
        case "observe":
          return {
            readiness,
            manifest: native.manifest,
            counts: native.manifest.counts,
            expectedCounts: SCALE,
            files: files.length,
            ready: [...ready],
            entries: Array.from(app.index.values()),
            taskMembers: native.manifest.sessions.filter((row) =>
              sessionFamily(row.id, (id) => app.index.get(id)).some((id) =>
                id === native.manifest.sessions[0].id ||
                id === native.manifest.sessions[4].id
              )
            ).map((row) => row.id),
            expectedCosts: Object.fromEntries(
              [0, 2, 3, 250].map(
                (i) => [
                  native.manifest.sessions[i].id,
                  usageCost(native.manifest.sessions[i].expected.cost!),
                ],
              ),
            ),
            nativeEvents,
            frames: client.frames,
            requests: fake.requests,
            watches: watches.records,
            phases,
            sections,
            nativeReads,
            serving: serving.samples,
          };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "nativeRequest":
          return await native.request(frame.params.path, {
            method: frame.params.method,
            body: frame.params.body,
            directory: frame.params.project === "secondary"
              ? native.manifest.sessions[251].directory
              : native.directory,
          });
        case "queueScript": {
          const script = {
            chunks: frame.params.chunks,
            delay: frame.params.delay,
            ...(frame.params.tool ? { tool: frame.params.tool } : {}),
          };
          const id = crypto.randomUUID();
          if (frame.params.gate === "held") {
            const held = fake.queueHeld(script);
            gates.set(id, () => held.release());
          } else if (frame.params.gate === "stepped") {
            const stepped = fake.queueStepped(script);
            gates.set(id, () => stepped.next());
          } else fake.queue(script);
          return { gate: id };
        }
        case "releaseGate": {
          const release = gates.get(frame.params.gate);
          if (!release) throw new Error("Unknown population gate");
          release();
          return null;
        }
        case "writeProjectFiles":
          for (const [name, text] of Object.entries(frame.params.files)) {
            const target = resolve(native.directory, name),
              path = relative(native.directory, target);
            if (
              !path || path.startsWith("..") || path.startsWith("/")
            ) throw new Error("File outside population");
            let parent = native.directory;
            for (const part of path.split("/").slice(0, -1)) {
              parent = join(parent, part);
              await Deno.mkdir(parent, { recursive: true });
              if ((await Deno.lstat(parent)).isSymlink) {
                throw new Error(
                  "Symlink parent",
                );
              }
            }
            try {
              if ((await Deno.lstat(target)).isSymlink) {
                throw new Error(
                  "Symlink target",
                );
              }
            } catch (error) {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            }
            await Deno.writeTextFile(target, text);
          }
          return null;
        case "scenario":
          if (
            frame.params.action === "hold" && profile === "contract-scale-files"
          ) {
            client.send({ t: "resnapshot" });
            return null;
          }
          if (frame.params.action !== "stop") {
            throw new Error(
              "Unknown population action",
            );
          }
          serving.stop();
          return null;
        case "endTest":
          fake.releaseAll();
          await waitFor(() => fake.active, (count) => count === 0);
          if (fake.pending || fake.unexpected) {
            throw new Error("Population provider lease unsettled");
          }
          lease = undefined;
          return null;
        case "stop":
          fake.releaseAll();
          await client.close();
          await app.stop();
          return null;
        default:
          throw new Error("Command outside population profile");
      }
    },
  };
}
