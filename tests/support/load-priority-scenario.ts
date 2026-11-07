// SPDX-License-Identifier: LGPL-3.0-only
import { DigestScheduler } from "@otk/harness";
import { digestProgressSource } from "../../core/features/digest-progress.ts";
import { cfg, fixture } from "./config.ts";
import { coreBackendFixture } from "./core-backend.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { resources } from "./resources.ts";
import type { ControlRequest, TestLease } from "./fixture-control.ts";

/** Real view-lease/scheduler and shipped browser, with a held page producer. */
export async function loadPriorityScenario() {
  const root = await fixture(), held = Promise.withResolvers<void>();
  let pumping = false, reads = 0;
  const jobs: string[] = [];
  const scheduler = new DigestScheduler({ ...cfg().digest, cpu: 1 }, {
    freeMemory: () => Number.MAX_SAFE_INTEGER,
    sleep: () => Promise.resolve(),
    wake: () => {
      if (pumping) return;
      pumping = true;
      queueMicrotask(async () => {
        try {
          while (await scheduler.tick()) { /* event-driven drain */ }
        } finally {
          pumping = false;
        }
      });
    },
  });
  scheduler.viewers(false);
  resources().defer("load-priority scheduler", () => scheduler.stop());
  resources().defer("load-priority page", () => held.resolve());
  scheduler.register({
    identity: "test-v1",
    catalog: () => Promise.resolve({ entries: [], authoritative: true }),
    detail: () => Promise.reject(new Error("not requested")),
    step() {
      jobs.push("background");
      return Promise.resolve(undefined);
    },
    close() {},
  });
  scheduler.enqueue(
    { provider: "test-v1", sessionID: "backfill", updated: 1 },
    "background",
  );
  const f = await coreBackendFixture(root, {}, "tstv1-core", {
    sources: [digestProgressSource({
      scope: scheduler.setScope.bind(scheduler),
      release: scheduler.release.bind(scheduler),
      progress: () => [],
      observeProgress: () => () => {},
    })],
  });
  const read = f.app.backend.core.listMessages;
  f.app.backend.core.listMessages = async (...args) => {
    reads++;
    await held.promise;
    return await read(...args);
  };
  const rpc = f.app.requests.options.registry;
  await rpc.dispatch("prefs.set", { key: "theme", value: "otk-dark" });
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
  let lease: TestLease | undefined;
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign load lease");
      switch (frame.command) {
        case "beginTest":
          return lease = {
            lease: crypto.randomUUID(),
            directory: root,
            baseline: {},
          };
        case "observe":
          return { reads, jobs, session: f.session, requests: [] };
        case "productRpc":
          return await rpc.dispatch(frame.params.method, frame.params.params);
        case "scenario":
          if (frame.params.action !== "release") {
            throw new Error("Unknown load action");
          }
          held.resolve();
          return null;
        case "endTest":
          held.resolve();
          lease = undefined;
          return null;
        case "stop":
          held.resolve();
          await f.app.stop();
          await scheduler.stop();
          return null;
        default:
          throw new Error("Command outside load-priority profile");
      }
    },
  };
}
