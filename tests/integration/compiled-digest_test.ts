// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { preparedBinary } from "../support/prepared-binaries.ts";
import { createIndex } from "@otk/client";
import type { IndexEntry, MessagePage, TurnUsageDetail } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { helperParent } from "../support/helper-parent.ts";
import { freePort, OpencodeTest, waitFor } from "../support/opencode.ts";
import { ownedProcess } from "../support/process.ts";
import { tempDir, test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

test("shipped binary digests off-source with empty caches, follows SSE, retains tombstones and restarts", async () => {
  const root = await tempDir("shipped-digest-");
  const binary = await preparedBinary();
  const fake = new FakeLlm(),
    oc = await OpencodeTest.start(fake, { bash: "allow" });
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
  const run = async (deleted = false) => {
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
    client.lease({
      directory: oc.directory,
      selected: deleted ? undefined : session.id,
      crumbs: [],
      rows: deleted ? [session.id, lostID] : [],
    });
    await client.connect();
    if (!deleted) {
      await client.rpc("session.messages", { sessionID: session.id });
    }
    const index = createIndex();
    let cursor = 0;
    const entry = (id = session.id) => {
      client.entry(id);
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
    const welcome = first.client.frames.find((frame) => frame.t === "welcome");
    assert(welcome?.messages);
    assertEquals(welcome.messages.concurrency, 4);
    assertEquals(welcome.messages.coolms, 300000);
    assertEquals(welcome.messages.recoveryconcurrency, 2);
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
    const firstTurn = Object.keys(first.entry()!.digest.turns)[0];
    const terminalDetail = async (turnID: string) => {
      // Ready describes a reconciled snapshot, including a still-running call.
      // Compare immutable ledgers only after this turn's completion reaches us.
      await waitFor(
        first.entry,
        (entry) =>
          entry?.digest.state === "ready" &&
          entry.digest.turns[turnID]?.time?.end !== undefined,
      );
      const detail = await first.client.rpc<TurnUsageDetail>("usage.get", {
        sessionID: session.id,
        turnID,
      });
      assertEquals(
        detail.calls.every((call) =>
          call.completed && call.time?.end !== undefined
        ),
        true,
      );
      return detail;
    };
    const initialDetail = await terminalDetail(firstTurn);
    assertEquals(initialDetail.calls.length, 1);
    assertEquals(initialDetail.turnID, firstTurn);
    const initialCalls = first.entry()!.digest.total!.calls;
    for (let rank = 0; rank < 15; rank++) {
      await oc.request(`/session/${session.id}/message`, {
        method: "POST",
        body: {
          noReply: true,
          parts: [{ type: "text", text: `Compiled cursor prompt ${rank}` }],
        },
      });
    }
    fake.queue({ chunks: ["Compiled second charged turn"] });
    await oc.request(`/session/${session.id}/message`, {
      method: "POST",
      body: {
        model: { providerID: "fake", modelID: "scripted" },
        parts: [{ type: "text", text: "Charge the second compiled turn" }],
      },
    });
    await waitFor(
      first.entry,
      (entry) =>
        entry?.digest.state === "ready" &&
        entry.digest.total?.calls === initialCalls + 1,
    );
    const native = await oc.request<{ info: { id: string } }[]>(
      `/session/${session.id}/message`,
    );
    const newest = await first.client.rpc<MessagePage>("session.messages", {
      sessionID: session.id,
    });
    assertEquals(
      newest.items.map((message) => message.id),
      native.slice(-10).map((message) => message.info.id),
    );
    assertEquals(newest.items.length, 10);
    assert(newest.older);
    const older = await first.client.rpc<MessagePage>("session.messages", {
      sessionID: session.id,
      before: newest.older,
    });
    assertEquals(
      [...older.items, ...newest.items].map((message) => message.id),
      native.map((message) => message.info.id),
    );
    assertEquals(older.older, null);
    assertEquals(newest.prompt?.id, native.at(-2)!.info.id);
    const secondTurn = native.at(-2)!.info.id;
    const changedDetail = await terminalDetail(secondTurn);
    assertEquals(changedDetail.calls.length, 1);
    assertEquals(changedDetail.turnID, secondTurn);
    assertEquals(
      (await first.client.rpc<TurnUsageDetail>("usage.get", {
        sessionID: session.id,
        turnID: firstTurn,
      })).calls,
      initialDetail.calls,
    );
    const helper = await helperParent(oc);
    await waitFor(
      () => first.entry(helper.child.id),
      (entry) => entry?.digest.helper?.state === "ready",
    );
    assertEquals(first.entry(helper.child.id)!.digest.helper!.toolCount, 1);
    const helperPage = await first.client.rpc<MessagePage>("session.messages", {
      sessionID: helper.parent.id,
    });
    assertEquals(helperPage.items.length, 10);
    assertEquals(helperPage.helpers[helper.child.id].toolCount, 1);
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
  const second = await run(true);
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
