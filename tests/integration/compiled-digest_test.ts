// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { createIndex } from "@otk/client";
import type { IndexEntry } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { freePort, OpencodeTest, waitFor } from "../support/opencode.ts";
import { ownedProcess } from "../support/process.ts";
import { tempDir, test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

test("shipped binary digests off-source with empty caches, follows SSE, retains tombstones and restarts", async () => {
  const root = await tempDir("shipped-digest-"),
    source = fromFileUrl(new URL("../../", import.meta.url));
  const binary = Deno.env.get("OTK_TEST_BINARY") ?? join(root, "otk");
  if (!Deno.env.get("OTK_TEST_BINARY")) {
    const build = await new Deno.Command("bash", {
      cwd: source,
      args: ["scripts/compile.sh", "x86_64-unknown-linux-gnu", binary],
      stdout: "piped",
      stderr: "piped",
    }).output();
    await Deno.writeFile(
      join(root, "build.log"),
      new Uint8Array([...build.stdout, ...build.stderr]),
    );
    assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
  }
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const session = await oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Compiled supervision" },
  });
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const state = join(root, "state"), config = join(root, "otk.toml");
  await Deno.writeTextFile(
    config,
    `[server]\nport=${port}\n[auth]\ntype="none"\n[state]\npath=${
      JSON.stringify(state)
    }\n[harness]\nurl=${JSON.stringify(oc.url)}\ndb=${
      JSON.stringify(oc.db)
    }\n[digest]\nretryms=10\ncpu=1\nmemoryreserve=1\n`,
  );
  const run = async () => {
    const env = Object.fromEntries(
      Object.entries(Deno.env.toObject()).filter(([key]) =>
        !key.startsWith("OTK_")
      ),
    );
    Object.assign(env, {
      OTK_CONFIG: config,
      DENO_DIR: join(root, `empty-${crypto.randomUUID()}`),
      DENO_NO_REMOTE: "1",
      TMPDIR: Deno.env.get("TMPDIR")!,
    });
    const process = ownedProcess(binary, [], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    process.child.stdout!.on("data", (chunk) => {
      log += chunk.toString();
    });
    process.child.stderr!.on("data", (chunk) => {
      log += chunk.toString();
    });
    await waitFor(async () => (await fetch(url + "/api/health")).ok, Boolean);
    const client = new WsClient(url);
    await client.connect();
    const index = createIndex();
    let cursor = 0;
    const entry = (id = session.id) => {
      for (const frame of client.frames.slice(cursor)) {
        if (frame.t === "index.snapshot" || frame.t === "index.patch") {
          assertEquals(index.receive("compiled", frame), true);
        }
      }
      cursor = client.frames.length;
      return index.state.entries[`compiled/${id}`] as
        | IndexEntry
        | undefined;
    };
    return {
      client,
      entry,
      stop: async () => {
        await client.close();
        await process.stop();
        await Deno.writeTextFile(
          join(root, `runtime-${crypto.randomUUID()}.log`),
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
  const marker = `provider-only-body-${crypto.randomUUID()}`;
  let lostID = "";
  const first = await run();
  try {
    await waitFor(first.entry, (entry) => entry?.digest.state === "ready");
    assertEquals(first.entry()?.digest.messageCount, 0);
    fake.queue({ chunks: ["Shipped compiled reply"] });
    await oc.request(`/session/${session.id}/message`, {
      method: "POST",
      body: {
        model: { providerID: "fake", modelID: "scripted" },
        parts: [{ type: "text", text: "Shipped compiled prompt" }],
      },
    });
    await waitFor(
      first.entry,
      (entry) =>
        entry?.digest.state === "ready" && (entry.digest.total?.calls ?? 0) > 0,
    );
    assertEquals(Object.keys(first.entry()!.digest.turns).length > 0, true);
    const lost = await oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Provider loss metadata" },
    });
    lostID = lost.id;
    fake.queue({ chunks: [marker] });
    await oc.request(`/session/${lostID}/message`, {
      method: "POST",
      body: {
        model: { providerID: "fake", modelID: "scripted" },
        parts: [{ type: "text", text: "Native-only provider loss prompt" }],
      },
    });
    await waitFor(
      () => first.entry(lostID),
      (entry) =>
        entry?.digest.state === "ready" && (entry.digest.total?.calls ?? 0) > 0,
    );
    const body = await first.client.rpc("session.messages", {
      sessionID: lostID,
    });
    assertEquals(JSON.stringify(body).includes(marker), true);
    await first.client.rpc("tasks.create", {
      directory: oc.directory,
      name: "Retained compiled task",
      sessions: [session.id],
    });
    await first.client.rpc("session.delete", { sessionID: session.id });
    await waitFor(first.entry, (entry) => entry?.deleted?.how === "otk");
  } finally {
    await first.stop();
  }
  // All effects remain inside this fixture. The old binary and stock server
  // are joined before removing the native DB and reopening a fresh one.
  await oc.stop();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Deno.remove(oc.db + suffix);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  await oc.restart();
  const second = await run();
  try {
    await waitFor(second.entry, (entry) => entry?.deleted?.how === "otk");
    assertEquals(second.entry()!.digest.total!.calls > 0, true);
    await waitFor(
      () => second.entry(lostID),
      (entry) => entry?.deleted?.how === "provider",
    );
    assertEquals(second.entry(lostID)!.digest.total!.calls > 0, true);
    assertEquals(JSON.stringify(second.entry(lostID)).includes(marker), false);
    await assertRejects(() =>
      second.client.rpc("session.messages", { sessionID: lostID })
    );
    for (const name of ["digest.db", "digest.db-wal", "digest.db-shm"]) {
      try {
        assertEquals(
          new TextDecoder().decode(await Deno.readFile(join(state, name)))
            .includes(marker),
          false,
          name,
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    assertEquals(
      (await second.client.rpc<{ sessions: string[] }[]>("tasks.list", {}))[0]
        .sessions,
      [session.id],
    );
    await assertRejects(() =>
      second.client.rpc("session.messages", {
        sessionID: session.id,
      })
    );
  } finally {
    await second.stop();
  }
});
