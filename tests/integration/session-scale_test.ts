// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { start } from "../../main.ts";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { freePort, waitFor } from "../support/opencode.ts";
import { resources, tempDir, test } from "../support/resources.ts";
import { SCALE, SessionScale } from "../support/session-scale.ts";
import { servingProbe } from "../support/serving-probe.ts";
import { WsClient } from "../support/ws-client.ts";

test("scale generation refuses escaped or existing destinations before native admission", async () => {
  const root = await tempDir("scale-boundary-"), fake = new FakeLlm();
  const existing = join(root, "existing");
  await Deno.mkdir(existing);
  await Deno.writeTextFile(join(existing, "keep.txt"), "untouched");
  await assertRejects(
    () => SessionScale.create(join(root, "..", "escaped-scale"), root, fake),
    Error,
    "inside the supplied",
  );
  await assertRejects(
    () => SessionScale.create(existing, root, fake),
    Deno.errors.AlreadyExists,
  );
  const outside = await tempDir("scale-outside-");
  await Deno.symlink(outside, join(root, "link"));
  await assertRejects(
    () => SessionScale.create(join(root, "link", "escaped"), root, fake),
    Error,
    "inside the supplied",
  );
  assertEquals([...Deno.readDirSync(outside)], []);
  assertEquals(
    await Deno.readTextFile(join(existing, "keep.txt")),
    "untouched",
  );
  assertEquals([...Deno.readDirSync(existing)].map((entry) => entry.name), [
    "keep.txt",
  ]);
});

test("serving-isolate timing control detects a real synchronous block", async () => {
  const probe = servingProbe();
  await new Promise((r) => setTimeout(r, 10));
  const until = performance.now() + 65;
  while (performance.now() < until) { /* deliberate negative control */ }
  await new Promise((r) => setTimeout(r, 10));
  probe.stop();
  assert(
    probe.samples.some((sample) => sample.ms >= 50),
    "The control must observe its deliberate block",
  );
  probe.assert();
});

test("real-version scale summaries match independent totals with bounded serving-isolate work", async () => {
  const root = await tempDir("sc-"), fake = new FakeLlm();
  const fixture = await SessionScale.create(join(root, "fixture"), root, fake);
  await Deno.writeTextFile(
    join(root, "scale-manifest.json"),
    JSON.stringify(fixture.manifest),
  );
  assertEquals(fixture.manifest.counts, SCALE);
  const config = cfg();
  config.server.port = freePort();
  config.auth.type = "none";
  config.state.path = join(root, "otk");
  config.harness.url = fixture.url;
  config.harness.db = fixture.db;
  const probe = servingProbe(false);
  resources().evidence(
    "serving raw samples",
    () =>
      Deno.writeTextFile(
        join(root, "serving-samples.json"),
        JSON.stringify({ counts: SCALE, samples: probe.samples }, null, 2),
      ),
  );
  resources().defer("serving probe", () => probe.stop());
  const pressure: unknown[] = [];
  let nativeReads: Record<string, number> = {};
  resources().evidence(
    "worker pressure",
    () =>
      Deno.writeTextFile(
        join(root, "worker-pressure.json"),
        JSON.stringify(pressure),
      ),
  );
  const readinessStarted = performance.now();
  const app = await start(config, {
    admission: probe.start,
    section: probe.section,
    pressure: (value) => {
      nativeReads = value.nativeReads ?? {};
      const sample = {
        ...value,
        memory: Deno.systemMemoryInfo(),
        at: performance.now(),
      };
      pressure.push(sample);
      if (pressure.length <= 5 || pressure.length % 250 === 0) {
        console.info("Worker slice", sample);
      }
    },
  });
  resources().defer("scale application", () => app.stop());
  const client = new WsClient(`http://127.0.0.1:${config.server.port}`);
  await client.connect();
  const present = new Set<string>(), ready = new Set<string>();
  const observe = (entry: import("@otk/protocol").IndexEntry) => {
    present.add(entry.id);
    if (entry.digest.state === "ready") ready.add(entry.id);
    else ready.delete(entry.id);
  };
  for (const entry of app.index.values()) observe(entry);
  const unobserve = app.index.observe(observe);
  resources().defer("scale observations", unobserve);
  await waitFor(() => present.size, (n) => n === SCALE.sessions, 120000);
  await client.rpc("digests.scope", {
    directory: fixture.directory,
    sessions: [],
  });
  const task = await client.rpc<{ id: string }>("tasks.create", {
    directory: fixture.directory,
    name: "Scale pending work",
    sessions: [],
  });
  await client.rpc("tasks.rename", {
    id: task.id,
    name: "Scale saved outcome",
  });
  assert(
    (await client.rpc<{ id: string; name: string }[]>("tasks.list", {})).some(
      (t) => t.id === task.id && t.name === "Scale saved outcome",
    ),
  );
  while (ready.size < SCALE.sessions) {
    const previous = ready.size;
    // Backfill duration is a measurement; only stalled progress is a failure.
    await waitFor(() => ready.size, (n) => n > previous, 60_000);
  }
  assertEquals(ready.size, SCALE.sessions);
  const elapsedMs = performance.now() - readinessStarted;
  const readiness = {
    sessions: ready.size,
    elapsedMs,
    sessionsPerSecond: ready.size / (elapsedMs / 1000),
  };
  await Deno.writeTextFile(
    join(root, "scale-readiness.json"),
    JSON.stringify(readiness, null, 2),
  );
  console.info("Scale all-ready measurements", readiness);
  // Include serialization of the complete warm snapshot and normal live events.
  client.send({ t: "resnapshot" });
  await waitFor(
    () => client.frames.filter((f) => f.t === "index.snapshot").length,
    (n) => n >= 2,
  );
  const session = fixture.manifest.sessions[251];
  fake.queue({ chunks: ["Scale native outcome"] });
  await fixture.request(`/session/${session.nativeID}/message`, {
    method: "POST",
    directory: session.directory,
    body: {
      model: { providerID: "fake", modelID: "scripted" },
      parts: [{ type: "text", text: "Scale prompt" }],
    },
  });
  await waitFor(
    () => app.index.get(session.id)?.digest,
    (n) =>
      n?.state === "ready" && (n.messageCount ?? 0) > session.expected.messages,
  );
  await new Promise((r) => setTimeout(r, 10));
  probe.stop();
  const messages = fixture.manifest.sessions.reduce(
    (sum, row) => sum + row.expected.messages,
    0,
  );
  assert(
    (nativeReads.headers ?? 0) > 0,
    "The probe must observe actual native SQL reads",
  );
  assert(
    (nativeReads.headers ?? 0) <=
      SCALE.sessions + Math.ceil(messages / config.digest.batch) + 10,
    JSON.stringify(nativeReads),
  );
  assertEquals(
    nativeReads.tools ?? 0,
    0,
    "Summary backfill must read zero transcript parts",
  );
  console.info("Scale native SQL query counts", nativeReads);
  const snapshot = client.frames.findLast((frame) =>
    frame.t === "index.snapshot"
  );
  assert(snapshot?.t === "index.snapshot");
  const wire = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  await Deno.writeTextFile(
    join(root, "serving-samples.json"),
    JSON.stringify({ counts: SCALE, samples: probe.samples }, null, 2),
  );
  console.info(
    "Scale timer maximum",
    Math.max(...probe.samples.map((s) => s.ms)),
  );
  probe.assert();
  for (
    const row of fixture.manifest.sessions.filter((s) =>
      s.directory === fixture.directory
    )
  ) {
    const entry = app.index.get(row.id)!;
    assertEquals(
      wire.get(row.id)?.digest,
      entry.digest,
      "Complete wire snapshot must carry all consumer summaries",
    );
    assertEquals(entry.digest.messageCount, row.expected.messages, row.id);
    assertEquals(entry.digest.total?.calls, row.expected.calls, row.id);
    if (row.expected.cost === null) {
      assertEquals(entry.digest.total?.cost, null);
    } else {assert(
        Math.abs(entry.digest.total!.cost! - row.expected.cost) < 1e-8,
        row.id,
      );}
    const tokens = entry.digest.total!.tokens;
    assertEquals(
      [
        tokens.input,
        tokens.output,
        tokens.reasoning,
        tokens.cache.read,
        tokens.cache.write,
      ],
      row.expected.tokens,
      row.id,
    );
    assertEquals(
      Object.keys(entry.digest.turns).length,
      Object.keys(row.expected.turns).length,
      row.id,
    );
    for (const [id, expected] of Object.entries(row.expected.turns)) {
      const actual = entry.digest.turns[id];
      assertEquals(actual.calls, expected.calls);
      assertEquals(actual.cost, expected.cost);
    }
  }
  await client.close();
  await app.stop();
});
