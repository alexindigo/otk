// SPDX-License-Identifier: LGPL-3.0-only
import { assert } from "@std/assert";
import type { FromWorker, ToWorker } from "../../../core/digest/protocol.ts";
import { bounded, resources, tempDir, test } from "../../support/resources.ts";
import { waitFor } from "../../support/opencode.ts";

test("essential transcript metadata is served while bulk catalog publication awaits credit", async () => {
  const root = await tempDir("mc-");
  const entries = Array.from({ length: 6 }, (_, i) => ({
    id: `ses_metadata${i}`,
    projectID: "fixture",
    directory: "/fixture",
    title: `Metadata ${i}`,
    time: { created: i + 1, updated: i + 1 },
  }));
  const native = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/global/health") return Response.json({ healthy: true });
      if (path === "/experimental/session") return Response.json(entries);
      if (/^\/session\/[^/]+\/message$/.test(path)) return Response.json([]);
      return new Response("Unexpected fixture request: " + path, {
        status: 500,
      });
    },
  );
  resources().defer("metadata native", () => native.shutdown());
  const worker = new Worker(
    new URL("../../../core/digest/worker.ts", import.meta.url).href,
    { type: "module" },
  );
  const frames: FromWorker[] = [];
  worker.onmessage = ({ data }: MessageEvent<FromWorker>) => frames.push(data);
  worker.onerror = (event) => {
    event.preventDefault();
    throw new Error(event.message);
  };
  resources().defer("metadata worker", () => worker.terminate());
  resources().evidence(
    "metadata admission frames",
    () =>
      Deno.writeTextFile(
        root + "/message-admission.json",
        JSON.stringify(frames, null, 2),
      ),
  );
  const run = crypto.randomUUID();
  const send = (value: ToWorker) => worker.postMessage(value);
  send({
    t: "start",
    run,
    id: 1,
    provider: "opencode-v1",
    statePath: root,
    since: 0,
    native: {
      harness: {
        url: `http://127.0.0.1:${native.addr.port}`,
        username: "",
        password: "",
        db: root + "/absent.db",
        heartbeattimeout: 25,
        reconnectmax: 30,
        requestms: 60000,
      },
      index: { days: 30 },
    },
    policy: {
      batch: 2,
      slicems: 8,
      cpu: 1,
      memoryreserve: 1,
      maxpending: 128,
      publishrows: 2,
      retryms: 10,
      busyms: 100,
    },
  });
  await waitFor(
    () => frames.some((f) => f.t === "accepted" && f.id === 1),
    Boolean,
  );
  send({ t: "credit", run, id: 2, publications: 1 });
  send({ t: "catalog", run, id: 3, connection: 1 });
  await waitFor(
    () =>
      frames.some((f) =>
        f.t === "catalog" && f.id === 3 && f.part === 0 && !f.last
      ),
    Boolean,
  );
  send({
    t: "transcript",
    run,
    id: 4,
    sessionID: "opcv1-ses_metadata0",
    turns: [],
  });
  const received = waitFor(
    () => frames.some((f) => f.t === "transcript" && f.id === 4),
    Boolean,
    2000,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const independent = await Promise.race([
      received.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 200);
      }),
    ]);
    assert(
      independent,
      "A metadata-only initial page read is blocked by unrelated bulk catalog publication credit",
    );
  } finally {
    clearTimeout(timer);
    send({ t: "credit", run, id: 5, publications: 1000 });
    await bounded("metadata after publication credit", received);
    send({ t: "stop", run, id: 6 });
    await waitFor(() => frames.some((f) => f.t === "stopped"), Boolean);
  }
});
