// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { basename, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { FakeLlm } from "../../support/fake-llm.ts";
import {
  SCALE,
  SCALE_VARIANTS,
  SessionScale,
} from "../../support/session-scale.ts";
import {
  checkpoint,
  copyTree,
  fileHashes,
  stateRoot,
  verifyFiles,
} from "../../support/snapshots.ts";
import { relocateScale } from "../../support/scale-relocation.ts";
import { bounded, resources, tempDir, test } from "../../support/resources.ts";
import { ownedProcess } from "../../support/process.ts";
import { waitFor } from "../../support/opencode.ts";
import {
  type Command,
  type Commands,
  request,
  response,
  type StackInfo,
  type TestLease,
} from "../../support/fixture-control.ts";
import { nativeKind, nativeVersion } from "../../support/native.ts";
import { V2SessionScale } from "../../support/v2-session-scale.ts";
import { v1NativeTests } from "../../support/native-contract.ts";
const v1Test = v1NativeTests(
  "V1 stopped database snapshots, SQL relocation and V1 controller snapshot keys",
  ["tests/integration/scale/v2-snapshot-fixtures_test.ts#OC2Scale1"],
);
import { WsClient } from "../../support/ws-client.ts";

test("snapshot keys separate variants and corrupt existing keys are preserved without regeneration under an inode-stable lock", async () => {
  const root = await tempDir("snapshot-invalid-"),
    tmp = Deno.env.get("TMPDIR")!;
  await Deno.mkdir(join(root, "tmp"));
  Deno.env.set("TMPDIR", join(root, "tmp"));
  try {
    const scale = nativeKind === "opencode-v2-server"
      ? V2SessionScale
      : SessionScale;
    const bucket = nativeKind === "opencode-v2-server"
      ? "v2-scale"
      : "snapshots";
    const a = await scale.identity("sessions"),
      b = await scale.identity("messages");
    assertNotEquals(a.key, b.key);
    assert(a.key.includes(a.binary) && a.key.includes(a.fixture));
    const target = join(stateRoot(), bucket, a.key);
    await Deno.mkdir(target, { recursive: true });
    await Deno.writeTextFile(
      join(target, "diagnostic"),
      "preserve corrupt key",
    );
    const fake = new FakeLlm();
    await assertRejects(
      () => scale.generate("sessions", fake),
      Deno.errors.NotFound,
    );
    const inode = (await Deno.stat(target + ".lock")).ino;
    await assertRejects(
      () => scale.generate("sessions", fake),
      Deno.errors.NotFound,
    );
    assertEquals((await Deno.stat(target + ".lock")).ino, inode);
    assertEquals(
      await Deno.readTextFile(join(target, "diagnostic")),
      "preserve corrupt key",
    );
    assertEquals(
      [...Deno.readDirSync(join(stateRoot(), bucket))].map((entry) =>
        entry.name
      ).sort(),
      [a.key, a.key + ".lock"].sort(),
    );
  } finally {
    Deno.env.set("TMPDIR", tmp);
  }
});

test("stopped WAL-backed snapshot keeps committed sentinel; main-file-only copy is inconsistent", async () => {
  const root = await tempDir("snapshot-wal-"), source = join(root, "source");
  await Deno.mkdir(source);
  const path = join(source, "seed.db");
  const ready = join(root, "committed");
  // Abrupt writer exit models a stopped source with an uncheckpointed committed WAL.
  // No file is copied or removed beside a live writer.
  const writer = ownedProcess(Deno.execPath(), [
    "eval",
    `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${
      JSON.stringify(path)
    });db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sentinels(value TEXT);');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.exec("INSERT INTO sentinels VALUES('committed-in-wal')");await Deno.writeTextFile(${
      JSON.stringify(ready)
    },'ready');setInterval(()=>{},1000);`,
  ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  await waitFor(
    async () => {
      try {
        return await Deno.readTextFile(ready);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        return "";
      }
    },
    (s) => s === "ready",
    10000,
  );
  const closed = new Promise<void>((resolve) =>
    writer.child.once("close", () => resolve())
  );
  writer.child.kill("SIGKILL");
  await closed;
  const mainOnlyRoot = join(root, "main-only");
  await Deno.mkdir(mainOnlyRoot);
  const mainOnly = join(mainOnlyRoot, "seed.db"),
    originalFiles = await fileHashes(source);
  await Deno.copyFile(path, mainOnly);
  await assertRejects(
    () => verifyFiles(mainOnlyRoot, originalFiles),
    Error,
    "inventory/hash mismatch",
  );
  const wrong = new DatabaseSync(mainOnly);
  try {
    assertEquals(wrong.prepare("SELECT count(*) n FROM sentinels").get()!.n, 0);
  } finally {
    wrong.close();
  }
  checkpoint(path);
  const consistent = join(root, "consistent");
  await Deno.mkdir(consistent);
  await copyTree(source, consistent);
  await verifyFiles(consistent, await fileHashes(source));
  const copy = join(consistent, "seed.db");
  const db = new DatabaseSync(copy);
  try {
    assertEquals(
      db.prepare("SELECT value FROM sentinels").all().map((r) => r.value),
      ["committed-in-wal"],
    );
  } finally {
    db.close();
  }
  assertNotEquals(await fileHashes(root), {});
});

for (const variant of SCALE_VARIANTS) {
  v1Test(
    `versioned ${variant} snapshot relocates concurrent private copies without changing source`,
    async () => {
      const root = await tempDir("snapshot-clones-"), fake = new FakeLlm();
      const [template, joined] = await Promise.all([
        SessionScale.generate(variant, fake),
        SessionScale.generate(variant, fake),
      ]);
      assertEquals(joined, template);
      const source = await fileHashes(template),
        original = await SessionScale.validate(template);
      const inode = (await Deno.stat(template + ".lock")).ino;
      assertEquals((await Deno.stat(joined + ".lock")).ino, inode);
      assertEquals(
        basename(template),
        (await SessionScale.identity(variant)).key,
      );
      assert(
        !Object.keys(source).some((p) => /(^|\/)(otk|digest)\.db/.test(p)),
        "Native snapshots cannot warm OTK digestion",
      );
      assertEquals(original.scale.counts, SCALE);
      const [a, b] = await Promise.all([
        SessionScale.materialize(template, join(root, "a"), root, fake),
        SessionScale.materialize(template, join(root, "b"), root, fake),
      ]);
      assertNotEquals(a.directory, b.directory);
      for (const fixture of [a, b]) {
        const config = JSON.parse(
          await Deno.readTextFile(
            join(fixture.root, "config/opencode/opencode.json"),
          ),
        );
        assertEquals(
          config.provider.fake.options.baseURL,
          `http://127.0.0.1:${fake.port}/v1`,
        );
        assertEquals(fixture.manifest.counts, SCALE);
        const rows = await fixture.request<{ id: string; directory: string }[]>(
          "/experimental/session?limit=200",
        );
        assert(
          rows.length > 0 &&
            rows.every((row) => row.directory === fixture.directory),
        );
        const page = await fixture.request<
          { info: { id: string }; parts: unknown[] }[]
        >(`/session/${fixture.manifest.sessions[0].nativeID}/message?limit=10`);
        assertEquals(page.length, 10);
        assert(
          page.every((row) =>
            row.info.id.startsWith("msg_scale") && row.parts.length >= 3
          ),
        );
        await fixture.stop();
      }
      for (const [fixture, title] of [[a, "copy A"], [b, "copy B"]] as const) {
        const db = new DatabaseSync(fixture.db);
        try {
          db.prepare("UPDATE session SET title=? WHERE id='ses_scale000000'")
            .run(
              title,
            );
          assertEquals(
            db.prepare("SELECT title FROM session WHERE id='ses_scale000000'")
              .get()!.title,
            title,
          );
        } finally {
          db.close();
        }
      }
      assertEquals(await fileHashes(template), source);
      await SessionScale.validate(template);
      // Refuse an uncharacterized path-bearing JSON field transactionally.
      const bad = join(root, "bad");
      await Deno.mkdir(bad);
      await copyTree(join(template, "tree"), bad);
      const dbPath = join(bad, "data/opencode/opencode.db"),
        db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT id,data FROM message LIMIT 1").get()!;
        const value = JSON.parse(String(row.data));
        value.unknownPath = original.originalRoot + "/unexpected";
        db.prepare("UPDATE message SET data=? WHERE id=?").run(
          JSON.stringify(value),
          row.id,
        );
      } finally {
        db.close();
      }
      assertThrows(
        () => relocateScale(dbPath, original, join(root, "new")),
        Error,
        "Unknown message path",
      );
      await assertRejects(
        () => SessionScale.materialize(template, a.root, root, fake),
        Deno.errors.AlreadyExists,
      );
      assertEquals(await fileHashes(template), source);
    },
  );
}

v1Test(
  "isolated controller materializes the checked native key before a fresh OTK consumer reads wire totals",
  async () => {
    const root = await tempDir("snapshot-controller-"), fake = new FakeLlm();
    const template = await SessionScale.generate("sessions", fake),
      key = basename(template);
    const manifest = await SessionScale.validate(template),
      original = await fileHashes(template);
    const unit = `otk-t1c3-snapshot-${crypto.randomUUID()}.service`;
    const env = Object.entries(Deno.env.toObject()).filter(([key]) =>
      key.startsWith("OTK_TEST_") ||
      ["PATH", "TMPDIR", "HOME", "DENO_DIR"].includes(key)
    ).map(([key, value]) => `--setenv=${key}=${value}`);
    const stopUnit = resources().defer("snapshot controller unit", async () => {
      const result = await new Deno.Command("systemctl", {
        args: ["--user", "stop", unit],
        signal: AbortSignal.timeout(15000),
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      const state = await new Deno.Command("systemctl", {
        args: ["--user", "show", unit, "-p", "ActiveState", "--value"],
        signal: AbortSignal.timeout(5000),
      }).output();
      assertEquals(new TextDecoder().decode(state.stdout).trim(), "inactive");
    }, 20000);
    const owner = ownedProcess("systemd-run", [
      "--user",
      "--pipe",
      "--wait",
      "--quiet",
      `--unit=${unit}`,
      "--property=KillMode=control-group",
      "--property=TimeoutStopSec=10s",
      `--working-directory=${Deno.cwd()}`,
      ...env,
      Deno.execPath(),
      "run",
      "-A",
      "tests/support/fixture-controller.ts",
    ], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    owner.child.stderr!.on(
      "data",
      (chunk) =>
        Deno.writeTextFileSync(join(root, "controller.log"), chunk.toString(), {
          append: true,
        }),
    );
    const lines = createInterface({ input: owner.child.stdout! });
    const reader = lines[Symbol.asyncIterator]();
    const call = async <T>(
      command: Command,
      params: Commands[Command],
    ): Promise<T> => {
      const frame = request({ v: 1, id: crypto.randomUUID(), command, params });
      owner.child.stdin!.write(JSON.stringify(frame) + "\n");
      const line = await bounded(
        `snapshot controller ${command}`,
        reader.next(),
        120000,
      );
      assert(!line.done);
      const result = response(JSON.parse(line.value));
      assertEquals(result.id, frame.id);
      assert(result.ok, JSON.stringify(result.error));
      return result.result as T;
    };
    const stacks: StackInfo[] = [];
    try {
      stacks.push(
        await call<StackInfo>("start", {
          profile: "isolated",
          version: nativeVersion,
        }),
      );
      const initial = await call<TestLease>("beginTest", {
        identity: "snapshot-control",
      });
      const restored = await call<{ stack: StackInfo; lease: TestLease }>(
        "materializeSnapshot",
        { lease: initial.lease, key },
      );
      stacks.push(restored.stack);
      assertNotEquals(restored.lease.lease, initial.lease);
      assertNotEquals(restored.lease.directory, manifest.scale.directory);
      const page = await fetch(
        `${restored.stack.nativeUrl}/session/ses_scale000000/message?limit=10&directory=${
          encodeURIComponent(restored.lease.directory)
        }`,
        { signal: AbortSignal.timeout(30000) },
      );
      assertEquals(page.status, 200);
      assertEquals((await page.json()).length, 10);
      const client = new WsClient(restored.stack.url);
      await client.connect();
      const target = manifest.scale.sessions[0];
      resources().evidence("snapshot controller consumer", async () => {
        await Deno.writeTextFile(
          join(root, "controller-consumer.json"),
          JSON.stringify({ restored, target, frames: client.frames }, null, 2),
        );
      });
      // Match a real visible consumer's public demand. Background order alone puts
      // this deliberately oldest session behind the entire unrelated population.
      await client.rpc("digests.scope", { sessions: [target.id] });
      await waitFor(
        () => client.entry(target.id),
        (entry) => entry?.digest.state === "ready",
        120000,
      );
      const entry = client.entry(target.id)!;
      assertEquals(entry.digest.messageCount, target.expected.messages);
      assertEquals(entry.digest.total!.calls, target.expected.calls);
      assertEquals(await fileHashes(template), original);
      await client.close();
      await call("endTest", { lease: restored.lease.lease });
      await call("stop", {});
    } finally {
      lines.close();
      await stopUnit();
      await owner.stop();
      await resources().observe(
        "snapshot controller ownership proof",
        async () => {
          for (const stack of stacks) {
            for (const pid of stack.pids) {
              const result = await new Deno.Command("/usr/bin/kill", {
                args: ["-0", String(pid)],
                signal: AbortSignal.timeout(5000),
              }).output();
              assert(!result.success, `Snapshot-owned PID survived: ${pid}`);
            }
            for (const port of stack.ports) {
              try {
                const connection = await Deno.connect({
                  hostname: "127.0.0.1",
                  port,
                });
                connection.close();
                throw new Error(`Snapshot-owned port survived: ${port}`);
              } catch (error) {
                if (
                  !(error instanceof Deno.errors.ConnectionRefused)
                ) throw error;
              }
            }
          }
          await Deno.writeTextFile(
            join(root, "controller-cleanup.json"),
            JSON.stringify(
              { unit, stacks, processesGone: true, portsClosed: true },
              null,
              2,
            ),
          );
        },
        20000,
      );
    }
  },
);
