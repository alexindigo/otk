// SPDX-License-Identifier: LGPL-3.0-only
import { derivedValue } from "@otk/protocol";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { preparedBinary } from "../support/prepared-binaries.ts";
import { createDirectoryCatalogs } from "@otk/client";
import {
  createCatalogCodecs,
  type DirectoryCatalog,
  type MessagePage,
  PROTOCOL_VERSION,
  type RequestRef,
  type RpcParams,
  SIDECAR_VERSION,
} from "@otk/protocol";
import {
  beta1State,
  upgradedManifest,
  userSnapshot,
} from "../support/beta1-state.ts";
import { DatabaseSync } from "node:sqlite";
import { FakeLlm } from "../support/fake-llm.ts";
import { freePort, OpencodeTest, waitFor } from "../support/opencode.ts";
import { ownedProcess } from "../support/process.ts";
import { resources, tempDir } from "../support/resources.ts";
import { v1NativeTests } from "../support/native-contract.ts";
const test = v1NativeTests(
  "V1 beta.1 opcv1 references, legacy SQL, and version-specific capability inventory",
  [
    "tests/unit/core/opencode-v2-upgrade_test.ts#V2 proven reference upgrade",
    "tests/unit/core/opencode-v2-upgrade_test.ts#V2 reference collision",
    "tests/integration/v2-index_test.ts#OC2I1",
    "tests/integration/v2-catalogs_test.ts#OC2C3",
    "tests/integration/v2-actions_test.ts#OC2P3",
  ],
);
import { cfg } from "../support/config.ts";
import { AuthState } from "../../core/auth/state.ts";
import { WsClient } from "../support/ws-client.ts";
import { RemainingMeasurements } from "../support/remaining-measurements.ts";

test("compiled beta.2 contracts upgrade beta.1 off-source and publish real catalogs, keyed tasks and prompt outcomes", async () => {
  const root = await tempDir("compiled-beta2-");
  const report = new RemainingMeasurements(root, "compiled-beta2-contracts");
  const binary = await preparedBinary();
  const fake = new FakeLlm(), native = await OpencodeTest.start(fake);
  const session = await native.session<{ id: string; nativeID: string }>(
    "/session",
    { method: "POST", body: { title: "Compiled upgraded session" } },
  );
  const unknown = await native.session<{ id: string; nativeID: string }>(
    "/session",
    {
      method: "POST",
      body: { title: "Historical unreported cost" },
    },
  );
  fake.queue({ chunks: ["Historical summary fixture"] });
  await native.request(`/session/${unknown.id}/message`, {
    method: "POST",
    body: {
      model: { providerID: "fake", modelID: "scripted" },
      parts: [{ type: "text", text: "Historical summary input" }],
    },
  });
  // Fixture-only historical metadata, following SessionScale's unreported-cost
  // case. The owned stock process is joined before touching its synthetic DB.
  await native.stop();
  const historical = new DatabaseSync(native.db);
  try {
    assertEquals(
      historical.prepare(
        "UPDATE message SET data=json_remove(data,'$.cost') WHERE session_id=? AND json_extract(data,'$.role')='assistant'",
      ).run(unknown.nativeID).changes,
      1,
    );
  } finally {
    historical.close();
  }
  await native.restart();
  const state = join(root, "state");
  const original = await beta1State(state, session.nativeID);
  const authPath = join(state, "auth.toml"), authConfig = cfg();
  authConfig.state.path = state;
  authConfig.auth.type = "";
  await new AuthState(authConfig).setup({ type: "none" });
  const authText = await Deno.readTextFile(authPath);
  const port = freePort(), url = `http://127.0.0.1:${port}`;
  const overlay = join(root, "otk.toml");
  await Deno.writeTextFile(
    overlay,
    `[server]\nport=${port}\n[auth]\ntype="none"\n[state]\npath=${
      JSON.stringify(state)
    }\n[harness]\ntype="opencode1"\nurl=${JSON.stringify(native.url)}\ndb=${
      JSON.stringify(native.db)
    }\n[digest]\ncpu=1\nmemoryreserve=1\nretryms=10\n`,
  );
  const operatorText = await Deno.readTextFile(overlay);
  const run = async () => {
    const env = Object.fromEntries(
      Object.entries(Deno.env.toObject()).filter(([key]) =>
        !key.startsWith("OTK_")
      ),
    );
    Object.assign(env, {
      OTK_CONFIG: overlay,
      DENO_DIR: join(root, `empty-${crypto.randomUUID()}`),
      DENO_NO_REMOTE: "1",
      TMPDIR: Deno.env.get("TMPDIR")!,
    });
    let log = "";
    const logPath = join(root, `runtime-${crypto.randomUUID()}.log`);
    resources().evidence(
      "compiled runtime output",
      () => Deno.writeTextFile(logPath, log),
    );
    const process = ownedProcess(binary, [], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.child.stdout!.on("data", (chunk) => {
      log += chunk.toString();
    });
    process.child.stderr!.on("data", (chunk) => {
      log += chunk.toString();
    });
    await waitFor(async () => (await fetch(url + "/api/health")).ok, Boolean);
    const client = new WsClient(url);
    client.lease({
      directory: native.directory,
      selected: session.id,
      crumbs: [],
      rows: [unknown.id],
    });
    await client.connect();
    await client.rpc("session.messages", { sessionID: session.id });
    return {
      client,
      stop: async () => {
        await client.close();
        await process.stop();
        await Deno.writeTextFile(
          logPath,
          log,
        );
        assertEquals(
          /Download|Module not found|Cannot find/.test(log),
          false,
          log,
        );
      },
    };
  };
  const first = await run();
  try {
    const welcome = first.client.frames.find((frame) => frame.t === "welcome");
    assert(welcome?.t === "welcome");
    // C9 qualifies the incoming release candidate. C10 changes this exported
    // constant, so the same proof then requires the actual beta.2 version.
    assertEquals(welcome.sidecar.version, SIDECAR_VERSION);
    assertEquals(welcome.protocol, PROTOCOL_VERSION);
    assertEquals(welcome.sidecar.harness.kind, "opencode-v1");
    const readOnly = new DatabaseSync(join(state, "otk.db"), {
      readOnly: true,
    });
    try {
      const current = userSnapshot({ connection: readOnly });
      // Native discovery may add current-user projects during ordinary startup;
      // every historical row must still match the independent upgrade manifest.
      for (
        const [table, rows] of Object.entries(upgradedManifest(original.before))
      ) {
        for (const row of rows) {
          assert(
            current[table].some((value) =>
              JSON.stringify(value) === JSON.stringify(row)
            ),
            table,
          );
        }
      }
    } finally {
      readOnly.close();
    }
    await waitFor(
      () => first.client.entry(session.id)?.digest.state,
      (value) => value === "ready",
    );
    await waitFor(
      () => first.client.entry(unknown.id)?.digest,
      (value) =>
        value?.state === "ready" && derivedValue(value.total)?.cost === null,
    );
    const catalog = createDirectoryCatalogs({
      codecs: createCatalogCodecs(),
      watch: (directory) => {
        let ref: RequestRef | undefined;
        return {
          result: first.client.rpc<DirectoryCatalog>("catalogs.watch", {
            directory,
          }).then((value) => {
            const result = first.client.frames.find((frame) =>
              frame.t === "request.result" && frame.outcome.ok &&
              frame.outcome.result === value
            );
            assert(result?.t === "request.result");
            ref = result.ref;
            return value;
          }),
          release() {
            if (ref) first.client.send({ t: "request.release", refs: [ref] });
          },
        };
      },
      refresh: (directory) =>
        first.client.rpc("catalogs.refresh", { directory }).then(() => {}),
    });
    const lease = catalog.acquire(native.directory);
    let seen = 0;
    const pump = () => {
      for (const frame of first.client.frames.slice(seen)) {
        catalog.receive(frame);
      }
      seen = first.client.frames.length;
      return lease.state.catalog;
    };
    try {
      await lease.ready();
      await waitFor(
        pump,
        (value) =>
          value?.values.files?.value?.some((file) =>
            file.path === "README.md"
          ) === true,
      );
      await Deno.writeTextFile(
        join(native.directory, "compiled-new.txt"),
        "Compiled file update",
      );
      await lease.refresh();
      await waitFor(
        pump,
        (value) =>
          value?.values.files?.value?.some((file) =>
            file.path === "compiled-new.txt"
          ) === true,
      );
    } finally {
      lease.release();
      catalog.stop();
    }
    // Historical task metadata belongs to the preserved beta.1 project.
    first.client.lease({
      directory: "/project",
      selected: session.id,
      crumbs: [],
      rows: [],
    });
    await first.client.rpc("inbox.get", {});
    await first.client.rpc("tasks.rename", {
      id: "task-main",
      name: "Compiled keyed outcome",
    });
    const baselineCount = first.client.frames.filter((frame) =>
      frame.t === "inbox.snapshot"
    ).length;
    await first.client.wait((frame) =>
      frame.t === "inbox.patch" &&
      frame.ops.some((op) =>
        op.op === "task.upsert" && op.task.name === "Compiled keyed outcome"
      )
    );
    assertEquals(
      first.client.frames.filter((frame) => frame.t === "inbox.snapshot")
        .length,
      baselineCount,
    );
    first.client.lease({
      directory: native.directory,
      selected: session.id,
      crumbs: [],
      rows: [unknown.id],
    });
    // A digest counts headers, not completed replies. Force the count to arrive
    // before any output so this contract cannot depend on provider timing.
    const reply = fake.queueStepped({
      chunks: ["Compiled beta2 consumer outcome"],
    });
    first.client.send({ t: "subscribe", sessionID: session.id });
    await first.client.rpc(
      "session.prompt",
      {
        sessionID: session.id,
        mode: "normal",
        parts: [{ kind: "text", text: "Compiled provider-only prompt" }],
      } satisfies RpcParams<"session.prompt">,
    );
    await waitFor(
      () => first.client.entry(session.id)?.digest.messageCount,
      (count) => (count ?? 0) >= 2,
    );
    const pending = await first.client.rpc<MessagePage>("session.messages", {
      sessionID: session.id,
    });
    const assistant = pending.items.find((message) =>
      message.role === "assistant"
    );
    assert(assistant?.role === "assistant");
    assert(pending.prompt);
    assertEquals(assistant.replyTo, pending.prompt.id);
    assertEquals(assistant.time.completed, undefined);
    assertEquals(
      JSON.stringify(pending).includes("Compiled beta2 consumer outcome"),
      false,
    );
    // Prompt submission and the header count are not reply completion. Observe
    // this reply's terminal content event, then read its authoritative page once.
    reply.next();
    await first.client.wait((frame) =>
      frame.t === "content" && frame.sessionID === session.id &&
      frame.event.op === "message.upsert" &&
      frame.event.message.id === assistant.id &&
      frame.event.message.role === "assistant" &&
      frame.event.message.time.completed !== undefined
    );
    const page = await first.client.rpc<MessagePage>("session.messages", {
      sessionID: session.id,
    });
    assert(JSON.stringify(page).includes("Compiled beta2 consumer outcome"));
    const completed = page.items.find((message) => message.id === assistant.id);
    assert(completed?.role === "assistant");
    assert(completed.time.completed !== undefined);
    assert(
      JSON.stringify(completed).includes("Compiled beta2 consumer outcome"),
    );
    assertEquals(await Deno.readTextFile(authPath), authText);
    assertEquals(await Deno.readTextFile(overlay), operatorText);
    for (const name of ["otk.db", "otk.db-wal", "digest.db", "digest.db-wal"]) {
      try {
        const bytes = new TextDecoder().decode(
          await Deno.readFile(join(state, name)),
        );
        assert(!bytes.includes("Compiled provider-only prompt"), name);
        assert(!bytes.includes("Compiled beta2 consumer outcome"), name);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    await report.write({
      version: welcome.sidecar.version,
      protocol: welcome.protocol,
      upgradePreserved: true,
      actualCatalogRefresh: true,
      taskPatch: true,
      promptResult: true,
      noRuntimeDownloads: true,
    });
  } finally {
    await first.stop();
  }
  const second = await run();
  try {
    const tasks = await second.client.rpc<
      { name: string; sessions: string[] }[]
    >("tasks.list", { directory: "/project" });
    assertEquals(tasks[0].name, "Compiled keyed outcome");
    assertEquals(tasks[0].sessions, [session.id, "opcv1-ses_other"]);
    assertEquals(await Deno.readTextFile(authPath), authText);
    assertEquals(await Deno.readTextFile(overlay), operatorText);
    const page = await second.client.rpc<MessagePage>("session.messages", {
      sessionID: session.id,
    });
    assert(JSON.stringify(page).includes("Compiled beta2 consumer outcome"));
  } finally {
    await second.stop();
    await native.stop();
    await fake.stop();
  }
});
