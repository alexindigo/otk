// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { createCatalogCodecs } from "@otk/protocol";
import { join } from "@std/path";
import { start } from "../../main.ts";
import { cfg } from "./config.ts";
import { FakeLlm } from "./fake-llm.ts";
import { freePort, OpencodeTest, waitFor } from "./opencode.ts";
import { nativeBinary, nativeKind, nativeVersion } from "./native.ts";
import { V2SessionScale } from "./v2-session-scale.ts";
import {
  browserScenarioPath,
  browserSessionID,
  BrowserV2Native,
} from "./browser-native.ts";
import { useNativeDiscovery } from "./native-testing.ts";
import { resources } from "./resources.ts";
import { SessionScale } from "./session-scale.ts";
import type { ControlRequest, TestLease } from "./fixture-control.ts";

/** Paired stock-native populations; only the visible demand stays fixed. */
export async function loadPopulationScenario(large: boolean) {
  // Population ceiling from the owner sources documented in docs/load-contracts.md.
  const catalogKinds = Object.keys(createCatalogCodecs()).length;
  const refreshSources = [
    "initial lease",
    "native instance reset",
    "catalog.updated",
    "integration.updated",
    "reference.updated",
  ];
  const catalogBudget = {
    kinds: catalogKinds,
    refreshes: refreshSources.length,
    refreshSources,
    ceiling: catalogKinds * refreshSources.length,
  };
  const population = large ? 4000 : 200, projects = large ? 130 : 10;
  const selectedNative = "ses_scale000000",
    selected = browserSessionID(selectedNative);
  const fake = new FakeLlm();
  const v2 = nativeKind === "opencode-v2-server";
  if (!v2) await SessionScale.generate("sessions", fake);
  const key = v2 ? undefined : (await SessionScale.identity("sessions")).key;
  const native = v2
    ? new BrowserV2Native(
      await V2SessionScale.loadPopulation(fake, population, projects),
    )
    : await OpencodeTest.start(fake, { bash: "ask" }, {
      snapshot: key,
      prepare(oc) {
        // Edit only this stopped writable clone, never a running native or template.
        for (let i = 0; i < projects; i++) {
          Deno.mkdirSync(join(oc.root, "discovered", `project-${i}`), {
            recursive: true,
          });
        }
        const db = new DatabaseSync(join(oc.root, "data/opencode/opencode.db"));
        try {
          db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
          db.prepare(
            "DELETE FROM session WHERE id NOT IN (SELECT id FROM session ORDER BY id LIMIT ?)",
          ).run(population + 1);
          db.prepare("DELETE FROM message WHERE session_id<>?").run(
            selectedNative,
          );
          const rows = db.prepare(
            "SELECT id FROM session WHERE id<>? ORDER BY id",
          ).all(selectedNative);
          const update = db.prepare(
            "UPDATE session SET directory=?,parent_id=NULL,time_archived=NULL,revert=NULL WHERE id=?",
          );
          const samples = db.prepare(
            "SELECT data FROM message WHERE session_id=? ORDER BY id LIMIT 2",
          ).all(selectedNative);
          if (samples.length !== 2) {
            throw new Error("Missing characterized native headers");
          }
          const message = db.prepare(
            "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
          );
          const part = db.prepare(
            "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
          );
          rows.forEach((row, i) => {
            const directory = join(
              oc.root,
              "discovered",
              `project-${i % projects}`,
            );
            update.run(directory, row.id);
            const userID = `msg_load${String(i * 2).padStart(9, "0")}`;
            for (let rank = 0; rank < 2; rank++) {
              const id = `msg_load${String(i * 2 + rank).padStart(9, "0")}`;
              const data = JSON.parse(String(samples[rank].data));
              if (rank) {
                data.parentID = userID;
                data.path = { cwd: directory, root: directory };
              }
              message.run(
                id,
                row.id,
                1700000000000 + rank * 10,
                1700000000000 + rank * 10,
                JSON.stringify(data),
              );
              part.run(
                `prt_load${i}_${rank}`,
                id,
                row.id,
                1700000000000 + rank * 10,
                1700000000000 + rank * 10,
                JSON.stringify({
                  type: "text",
                  text: `Unseen complete session ${i}, message ${rank}`,
                }),
              );
            }
          });
          if (rows.length !== population) {
            throw new Error("Wrong load population");
          }
          const totals = db.prepare(
            "SELECT count(*) n FROM message WHERE session_id<>?",
          ).get(selectedNative);
          if (totals?.n !== population * 2) {
            throw new Error(
              "Unseen population must contain complete message pairs",
            );
          }
          db.exec("COMMIT");
        } finally {
          db.close();
        }
        return Promise.resolve();
      },
    });
  fake.strict();
  const requests: {
    at: number;
    method: string;
    path: string;
    directory: string | null;
  }[] = [];
  const proxy = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      requests.push({
        at: Date.now(),
        method: request.method,
        path: browserScenarioPath(native, url.pathname, request.method),
        directory: url.searchParams.get("directory") ??
          request.headers.get("x-opencode-directory"),
      });
      return fetch(
        new Request(new URL(url.pathname + url.search, native.url), request),
      );
    },
  );
  resources().defer("load native proxy", () => proxy.shutdown());
  const config = cfg();
  config.auth.type = "none";
  config.server.port = freePort();
  config.state.path = join(native.root, "load-state");
  config.harness.url = `http://127.0.0.1:${proxy.addr.port}`;
  config.harness.db = native.db;
  if (native instanceof BrowserV2Native) {
    config.harness.type = "opencode-v2-server";
    await useNativeDiscovery(native.native, config.harness.url);
  }
  const app = await start(config);
  resources().defer("load application", () => app.stop());
  await waitFor(
    () => app.connections.harnessState,
    (s) => s === "connected",
    120000,
  );
  const rpc = app.requests.options.registry;
  // Q1 replaces startup session membership with authoritative scalar project populations.
  await waitFor(
    async () => {
      const baseline = await rpc.dispatch(
        "inbox.get",
        {},
      ) as import("@otk/protocol").InboxBaseline;
      return Object.values(baseline.inbox.summaries ?? {}).reduce(
        (sum, row) => sum + ((row.direct ?? row).sessionCount ?? 0),
        0,
      );
    },
    (n) => n === population + 1,
    120000,
  );
  await rpc.dispatch("prefs.set", { key: "theme", value: "otk-dark" });
  await rpc.dispatch("layout.patch", { rightCollapsed: true });
  const info = {
    root: native.root,
    url: `http://127.0.0.1:${config.server.port}`,
    nativeUrl: native.url,
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid, native.process.pid!],
    ports: [config.server.port, native.port, proxy.addr.port],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  let lease: TestLease | undefined;
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign population lease");
      switch (frame.command) {
        case "beginTest":
          return lease = {
            lease: crypto.randomUUID(),
            directory: native.directory,
            baseline: {},
          };
        case "observe": {
          const baseline = await rpc.dispatch(
            "inbox.get",
            {},
          ) as import("@otk/protocol").InboxBaseline;
          return {
            population,
            projects,
            catalogBudget,
            selected,
            requests,
            unrelatedMessages: population * 2,
            directory: native.directory,
            // Q1 supersedes startup catalog membership; scalar seeds prove the complete native population.
            count: Object.values(baseline.inbox.summaries ?? {}).reduce(
              (sum, row) => sum + ((row.direct ?? row).sessionCount ?? 0),
              0,
            ),
          };
        }
        case "productRpc":
          return await rpc.dispatch(frame.params.method, frame.params.params);
        case "endTest":
          lease = undefined;
          return null;
        case "stop":
          await app.stop();
          await native.stop();
          await fake.stop();
          return null;
        default:
          throw new Error("Command outside population load profile");
      }
    },
  };
}
