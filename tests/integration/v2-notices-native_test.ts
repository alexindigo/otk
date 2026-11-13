// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createTranscriptProjection } from "@otk/client";
import {
  type NativeMessage,
  OpencodeV2ServerAdapter,
} from "@otk/harness-opencode-v2-server";
import {
  type Message,
  MESSAGE_PAGE_SIZE,
  type MessagePage,
} from "@otk/protocol";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";
import type { PluginStorage } from "@otk/harness";
import { OtkDb, pluginStorageMigrations, PluginStore } from "@otk/store";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { nativeKind } from "../support/native.ts";
import { waitFor } from "../support/opencode.ts";
import { resources, tempDir, withResources } from "../support/resources.ts";

async function observed(
  native: OpencodeV2Test,
  id: string,
  storage?: PluginStorage,
) {
  const config = cfg(),
    projection = createTranscriptProjection(),
    errors: unknown[] = [],
    removed: string[] = [];
  const adapter = new OpencodeV2ServerAdapter(
    {
      serviceFile: native.serviceFile,
      harness: config.harness,
      messages: config.messages,
    },
    undefined,
    (e) => errors.push(e),
  );
  resources().defer("notice adapter", () => adapter.core.stop());
  if (storage) adapter.storage(storage);
  await adapter.core.start({
    connection() {},
    indexReset() {},
    indexUpsert() {},
    indexRemove(id) {
      removed.push(id);
    },
    bootstrapComplete() {},
    invalidate() {},
    content: (_id, op) => projection.apply(op),
  });
  adapter.core.subscriptions(id, 1);
  projection.replace((await adapter.core.listMessages(id, {})).items);
  return { adapter, projection, errors, removed };
}
function record(message: Message) {
  return message.parts.find((p) => p.kind === "external" && p.activity);
}
Deno.test({
  name:
    "NT2R6 native deletion retires only that session's durable request records, including unviewed observations",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 request deletion", async () => {
      const root = await tempDir("v2-request-deletion-"),
        db = new OtkDb(root, [pluginStorageMigrations], { busyms: 1000 });
      resources().defer("V2 request deletion database", () => db.close());
      const fake = new FakeLlm(),
        native = await OpencodeV2Test.start(fake),
        a = await native.createSession(),
        b = await native.createSession();
      const { adapter, removed } = await observed(
        native,
        a.id,
        new PluginStore(db).scope("opencode-v2-server"),
      );
      const requests = [];
      for (const target of [a, b]) {
        const form = await native.api.session.form.create({
          sessionID: target.nativeID,
          title: "Preserve session ownership",
          fields: [{ type: "string", key: "answer", title: "Answer" }],
        });
        await native.api.session.form.cancel({
          sessionID: target.nativeID,
          formID: form.id,
        });
        await waitFor(
          () => adapter.transcript.requests.get(target.id, form.id),
          (record) => !!record?.outcome,
        );
        requests.push(form.id);
      }
      await native.api.session.remove({ sessionID: a.nativeID });
      await waitFor(() => Promise.resolve(removed.includes(a.id)), Boolean);
      assertEquals(
        await adapter.transcript.requests.get(a.id, requests[0]),
        undefined,
      );
      assert(
        (await adapter.transcript.requests.get(b.id, requests[1]))?.outcome,
      );
    }),
});
// Agent decoration and page source-order enrichment are independent metadata.
function presentation(message: Message) {
  return {
    id: message.id,
    role: message.role,
    source: message.source,
    parts: message.parts,
  };
}
function failingMcp(): string {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.json();
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize"
        ? {
          protocolVersion: body.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "NT2 failure fixture", version: "1" },
        }
        : body.method === "tools/list"
        ? {
          tools: [{
            name: "fail",
            description: "Return a deterministic failure",
            inputSchema: { type: "object", properties: {} },
          }],
        }
        : body.method === "tools/call"
        ? {
          isError: true,
          content: [{ type: "text", text: "Nested fixture failure" }],
        }
        : body.method === "resources/list"
        ? { resources: [] }
        : body.method === "resources/templates/list"
        ? { resourceTemplates: [] }
        : body.method === "prompts/list"
        ? { prompts: [] }
        : {};
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  );
  resources().defer("NT2 MCP fixture", () => server.shutdown());
  return `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/mcp`;
}
Deno.test({
  name:
    "NT2R1 settled and cancelled requests survive a real OTK process restart with bounded mixed-history paging",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 durable request history", async () => {
      const fake = new FakeLlm(),
        native = await OpencodeV2Test.start(fake),
        target = await native.createSession();
      const statePath = native.root + "/durable-otk";
      let app = await SidecarTest.start(native, { state: { path: statePath } });
      let ws = new WsClient(app.url);
      resources().defer("V2 durable history socket", () => ws.close());
      await ws.connect();
      await ws.rpc<MessagePage>("session.messages", { sessionID: target.id });
      const expected: string[] = [];
      for (let index = 0; index < 25; index++) {
        if (index % 5 === 0) {
          fake.queue({ chunks: [`Reply ${index}`] });
          await native.prompt(target.id, `Prompt ${index}`);
          await waitFor(() => native.api.session.active(), (rows) =>
            !rows[target.nativeID]);
        }
        const form = await native.api.session.form.create({
          sessionID: target.nativeID,
          title: `Durable form ${index}`,
          fields: [{ type: "string", key: "answer", title: "Answer" }],
        });
        if (index % 2) {
          await native.api.session.form.reply({
            sessionID: target.nativeID,
            formID: form.id,
            answer: { answer: `Saved ${index}` },
          });
        } else {await native.api.session.form.cancel({
            sessionID: target.nativeID,
            formID: form.id,
          });}
        expected.push(`request:${form.id}`);
      }
      const collect = async () => {
        const rows: Message[] = [], sizes: number[] = [];
        let before: string | undefined;
        do {
          const page = await ws.rpc<MessagePage>("session.messages", {
            sessionID: target.id,
            ...(before ? { before } : {}),
          });
          rows.unshift(...page.items);
          sizes.push(page.items.length);
          before = page.older ?? undefined;
        } while (before);
        assert(sizes.every((size) =>
          size <= MESSAGE_PAGE_SIZE
        ));
        assertEquals(new Set(rows.map((m) => m.id)).size, rows.length);
        return rows;
      };
      await waitFor(collect, (rows) =>
        rows.filter((m) => m.id.startsWith("request:")).length === 25);
      const prior = await collect();
      await ws.close();
      await app.stop();
      app = await SidecarTest.start(native, { state: { path: statePath } });
      ws = new WsClient(app.url);
      await ws.connect();
      const restored = await collect();
      assertEquals(
        restored.map((m) =>
          m.id
        ).sort(),
        prior.map((m) => m.id).sort(),
      );
      assertEquals(
        restored.filter((m) => m.id.startsWith("request:")).map((m) => m.id)
          .sort(),
        expected.sort(),
      );
      assertEquals(
        restored.filter((m) => m.id.startsWith("request:")).map(presentation),
        prior.filter((m) => m.id.startsWith("request:")).map(presentation),
      );
    }),
});
Deno.test({
  name:
    "NT2R7 unviewed settled request follows existing native history on the newest page",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 unviewed request order", async () => {
      const fake = new FakeLlm(),
        native = await OpencodeV2Test.start(fake),
        target = await native.createSession();
      for (let index = 0; index < 5; index++) {
        fake.queue({ chunks: [`Reply ${index}`] });
        await native.prompt(target.id, `Prompt ${index}`);
        await waitFor(() => native.api.session.active(), (rows) =>
          !rows[target.nativeID]);
      }
      const app = await SidecarTest.start(native), ws = new WsClient(app.url);
      resources().defer("V2 unviewed request socket", () =>
        ws.close());
      await ws.connect();
      const form = await native.api.session.form.create({
        sessionID: target.nativeID,
        title: "Newest unviewed request",
        fields: [{ type: "string", key: "answer", title: "Answer" }],
      });
      await native.api.session.form.cancel({
        sessionID: target.nativeID,
        formID: form.id,
      });
      // Inspect the plugin's stored identity through a read-only test connection.
      // A WS crumb would itself acquire transcript demand and invalidate this case.
      const stored = new DatabaseSync(`${native.root}/otk-${app.port}/otk.db`, {
        readOnly: true,
      });
      resources().defer(
        "V2 unviewed request observation",
        () => stored.close(),
      );
      await waitFor(() =>
        stored.prepare(
          "SELECT value FROM plugin_storage WHERE namespace=? AND key=?",
        ).get(
          "opencode-v2-server",
          `requests/identity/${encodeURIComponent(target.id)}/${
            encodeURIComponent(form.id)
          }`,
        ), (row) => !!row && !!JSON.parse(String(row.value)).outcome);
      const page = await ws.rpc<MessagePage>("session.messages", {
        sessionID: target.id,
      });
      assert(page.older);
      const cursor = JSON.parse(
        atob(page.older.replaceAll("-", "+").replaceAll("_", "/")),
      );
      assert(
        cursor.source.startsWith("sql"),
        `Expected SQL authority, got ${cursor.source}`,
      );
      assertEquals(page.items.at(-1)?.id, `request:${form.id}`);
    }),
});
/** Read-only view of the plugin's own stored record; never transcript demand. */
function storedRequest(file: string, sessionID: string, requestID: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare(
      "SELECT value FROM plugin_storage WHERE namespace=? AND key=?",
    ).get(
      "opencode-v2-server",
      `requests/identity/${encodeURIComponent(sessionID)}/${
        encodeURIComponent(requestID)
      }`,
    );
    return row ? JSON.parse(String(row.value)) : undefined;
  } finally {
    db.close();
  }
}
async function newest(app: SidecarTest, sessionID: string) {
  const ws = new WsClient(app.url);
  await ws.connect();
  try {
    return await ws.rpc<MessagePage>("session.messages", { sessionID });
  } finally {
    await ws.close();
  }
}
async function turn(
  fake: FakeLlm,
  native: OpencodeV2Test,
  target: { id: string; nativeID: string },
  text: string,
) {
  fake.queue({ chunks: [`Reply to ${text}`] });
  await native.prompt(target.id, text);
  await waitFor(
    () => native.api.session.active(),
    (rows) => !rows[target.nativeID],
  );
}
Deno.test({
  name:
    "NT2R8 unviewed settlements in one native gap keep delivery order above existing history across an OTK restart",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 unviewed request gap", async () => {
      const fake = new FakeLlm(),
        native = await OpencodeV2Test.start(fake),
        target = await native.createSession(),
        state = native.root + "/gap-otk";
      for (let index = 0; index < 5; index++) {
        await turn(fake, native, target, `Prompt ${index}`);
      }
      let app = await SidecarTest.start(native, { state: { path: state } });
      const forms: string[] = [];
      for (const title of ["First", "Second", "Third"]) {
        const form = await native.api.session.form.create({
          sessionID: target.nativeID,
          title,
          fields: [{ type: "string", key: "answer", title: "Answer" }],
        });
        if (title === "Second") {
          await native.api.session.form.reply({
            sessionID: target.nativeID,
            formID: form.id,
            answer: { answer: "kept" },
          });
        } else {
          await native.api.session.form.cancel({
            sessionID: target.nativeID,
            formID: form.id,
          });
        }
        forms.push(form.id);
      }
      // Records are retained before their position probe resolves; wait for
      // every position, not only the stored outcome.
      await waitFor(
        () =>
          Promise.resolve(
            forms.map((id) => storedRequest(state + "/otk.db", target.id, id)),
          ),
        (rows) =>
          rows.every((row) =>
            row?.outcome && row.position?.basis !== "pending"
          ),
      );
      const positions = forms.map((id) =>
        storedRequest(state + "/otk.db", target.id, id).position
      );
      // Delivery order is position order. Durable events without a message
      // (e.g. session updates) may separate them; native messages may not,
      // which the newest page below proves.
      for (let i = 1; i < positions.length; i++) {
        const [a, b] = [positions[i - 1], positions[i]];
        assert(
          a.after < b.after || (a.after === b.after && a.rank < b.rank),
          JSON.stringify(positions),
        );
      }
      await app.stop();
      app = await SidecarTest.start(native, { state: { path: state } });
      try {
        const page = await newest(app, target.id);
        assertEquals(
          page.items.slice(-3).map((m) => m.id),
          forms.map((id) => `request:${id}`),
        );
        const natives = page.items.filter((m) => !m.id.startsWith("request:"));
        assert(natives.length);
        assert(
          page.items.slice(-3).every((m) =>
            natives.every((n) => n.sourceOrder! < m.sourceOrder!)
          ),
        );
      } finally {
        await app.stop();
      }
    }),
});
Deno.test({
  name:
    "NT2R9 a native append after an unviewed settlement stays after it, and a committed revert retires only observations past its boundary",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 request append and revert", async () => {
      const fake = new FakeLlm(),
        native = await OpencodeV2Test.start(fake),
        target = await native.createSession();
      await turn(fake, native, target, "Before OTK");
      const app = await SidecarTest.start(native),
        file = `${native.root}/otk-${app.port}/otk.db`;
      resources().defer("V2 request revert sidecar", () => app.stop());
      const settle = async (title: string) => {
        const form = await native.api.session.form.create({
          sessionID: target.nativeID,
          title,
          fields: [{ type: "string", key: "answer", title: "Answer" }],
        });
        await native.api.session.form.cancel({
          sessionID: target.nativeID,
          formID: form.id,
        });
        await waitFor(
          () => Promise.resolve(storedRequest(file, target.id, form.id)),
          (row) => !!row?.outcome,
        );
        return form.id;
      };
      const kept = await settle("Kept");
      await turn(fake, native, target, "Appended");
      const reverted = await settle("Reverted");
      const order = (page: MessagePage) => page.items.map((m) => m.id);
      const rows = await nativeRows(native, target.nativeID);
      const appended = rows.find((m) =>
        m.type === "user" && m.text === "Appended"
      )!;
      const before = order(await newest(app, target.id));
      assert(
        before.indexOf(`request:${kept}`) < before.indexOf(appended.id),
        `Settlement must precede the later native append: ${before.join(", ")}`,
      );
      assertEquals(before.at(-1), `request:${reverted}`);
      // The append proved the first settlement's exact native predecessor.
      assertEquals(
        storedRequest(file, target.id, kept).position.basis,
        "stream",
      );
      await native.stageRevert(target.id, appended.id, false);
      await waitFor(
        async () => order(await newest(app, target.id)),
        (ids) => !ids.includes(appended.id),
      );
      const staged = order(await newest(app, target.id));
      assert(staged.includes(`request:${kept}`));
      assert(!staged.includes(`request:${reverted}`));
      await turn(fake, native, target, "After revert");
      await waitFor(
        () => Promise.resolve(storedRequest(file, target.id, reverted)),
        (row) => row === undefined,
      );
      const after = order(await newest(app, target.id));
      assert(after.includes(`request:${kept}`));
      assert(!after.includes(`request:${reverted}`));
      assert(!after.includes(appended.id));
    }),
});
Deno.test({
  name:
    "NT2R2 native queued synthetic and move survive cold snapshot with original inbox identity",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 queued context", async () => {
      const fake = new FakeLlm(),
        held = fake.queueHeld({ chunks: ["working"] }),
        native = await OpencodeV2Test.start(fake),
        target = await native.createSession(),
        { adapter, projection } = await observed(native, target.id);
      try {
        await native.prompt(target.id, "Hold the first reply");
        await waitFor(() => native.api.session.active(), (active) =>
          !!active[target.nativeID]);
        await native.api.session.synthetic({
          sessionID: target.nativeID,
          text: "Queued goal",
          delivery: "queue",
          resume: false,
        });
        await Deno.mkdir(native.directory + "/destination");
        await native.api.session.move({
          sessionID: target.nativeID,
          directory: native.directory + "/destination",
          delivery: "queue",
        });
        const queued = await native.api.session.inbox.list({
          sessionID: target.nativeID,
        });
        assertEquals(
          queued.map((row) =>
            row.type
          ),
          ["synthetic", "move"],
        );
        const snapshot = await adapter.core.listMessages(target.id, {});
        for (const row of queued) {
          assert(
            snapshot.items.some((m) => m.id === row.id && m.role === "context"),
          );
          await waitFor(
            () => projection.messages(),
            (rows) => rows.some((m) => m.id === row.id),
          );
          assertEquals(
            presentation(snapshot.items.find((m) => m.id === row.id)!),
            presentation(projection.messages().find((m) => m.id === row.id)!),
          );
          await native.api.session.inbox.cancel({
            sessionID: target.nativeID,
            inboxID: row.id,
          });
        }
      } finally {
        held.release();
      }
    }),
});
async function nativeRows(
  native: OpencodeV2Test,
  sessionID: string,
): Promise<NativeMessage[]> {
  return (await native.api.message.list({
    sessionID,
    limit: 200,
    order: "asc",
  })).data;
}
Deno.test({
  name:
    "NT2R3 notices stock synthetic, shell, skill and instruction records agree live, snapshot and reconnect",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 notices native", async () => {
      const fake = new FakeLlm(), config: Record<string, unknown> = {};
      const native = await OpencodeV2Test.start(fake, {
        config,
        prepare: async (f) => {
          await Deno.mkdir(f.directory + "/skills/review", { recursive: true });
          await Deno.writeTextFile(
            f.directory + "/skills/review/SKILL.md",
            "---\nname: review\ndescription: Review fixture\n---\n**Skill body**\n",
          );
          config.skills = [f.directory + "/skills"];
        },
      });
      const target = await native.createSession(),
        { adapter, projection } = await observed(native, target.id);
      for (const state of ["completed", "error", "cancelled"]) {
        await native.api.session.synthetic({
          sessionID: target.nativeID,
          resume: false,
          description: "Inspect fixture",
          text:
            `<subagent sessionID="ses_child" state="${state}" description="Inspect fixture">\n**${state}**\n\n| a | b |\n| --- | --- |\n| c | d |\n</subagent>`,
          metadata: {
            source: "subagent",
            state,
            agent: "junior",
            childID: "ses_child",
          },
        });
      }
      await native.api.session.synthetic({
        sessionID: target.nativeID,
        resume: false,
        text: "Goal continuation",
      });
      await waitFor(
        () => projection.messages().filter((m) => m.role === "context"),
        (rows) => rows.length >= 4,
      );
      const live = new Map(
        projection.messages().map((m) => [m.id, presentation(m)]),
      );
      const snapshot = await adapter.core.listMessages(target.id, {});
      for (const row of snapshot.items) {
        assertEquals(presentation(row), live.get(row.id));
      }
      native.proxy.disconnect();
      await waitFor(
        async () => (await adapter.core.listMessages(target.id, {})).items,
        (rows) => rows.length === snapshot.items.length,
      );
      for (
        const row of (await adapter.core.listMessages(target.id, {})).items
      ) {
        assertEquals(
          presentation(row),
          presentation(snapshot.items.find((m) => m.id === row.id)!),
        );
      }
      await native.api.session.shell({
        sessionID: target.nativeID,
        command: "printf shell-output; exit 7",
      });
      const shellPage = await waitFor(
        async () => (await adapter.core.listMessages(target.id, {})).items,
        (rows) =>
          rows.some((m) =>
            JSON.stringify(record(m)).includes("Exited with code 7")
          ),
      );
      assert(shellPage.some((m) =>
        record(m)?.kind === "external" &&
        JSON.stringify(record(m)).includes("shell-output")
      ));
      const skills = await native.api.skill.list({
        location: { directory: native.directory },
      });
      const skill = skills.data.find((s) => s.name === "review");
      assert(skill);
      await native.api.experimental.session.skill({
        sessionID: target.nativeID,
        id: skill.id,
        resume: false,
      });
      await waitFor(() => projection.messages(), (rows) =>
        rows.some((m) =>
          JSON.stringify(record(m)).includes("Skill review")
        ));
      await native.api.experimental.session.instructions.entry.put({
        sessionID: target.nativeID,
        key: "fixture",
        value: "Initial context",
      });
      fake.queue({ chunks: ["first"] });
      await native.prompt(target.id, "Initial instruction observation");
      await waitFor(() =>
        native.api.session.active(), (active) =>
        !active[target.nativeID]);
      assertEquals(
        (await nativeRows(native, target.nativeID)).filter((m) =>
          m.type === "system"
        ).length,
        0,
      );
      await native.api.experimental.session.instructions.entry.put({
        sessionID: target.nativeID,
        key: "fixture",
        value: "Keep all records",
      });
      fake.queue({ chunks: ["updated"] });
      await native.prompt(target.id, "Observe instruction change");
      await waitFor(() =>
        native.api.session.active(), (active) =>
        !active[target.nativeID]);
      const rows = await nativeRows(native, target.nativeID),
        systems = rows.filter((m) =>
          m.type === "system"
        );
      assert(systems.length > 0);
      const final = await adapter.core.listMessages(target.id, {});
      assert(final.items.some((m) =>
        record(m)?.kind === "external" &&
        JSON.stringify(record(m)).includes("Instructions updated:")
      ));
    }),
});

Deno.test({
  name:
    "NT2R4 stock completed shell and execute failures and external request settlement retain their facts",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 failure facts and requests", async () => {
      const fake = new FakeLlm(),
        native = await OpencodeV2Test.start(fake, {
          config: {
            mcp: {
              servers: {
                fixture: { type: "remote", url: failingMcp(), oauth: false },
              },
            },
            permissions: [{ action: "shell", resource: "*", effect: "ask" }, {
              action: "fixture_fail",
              resource: "*",
              effect: "allow",
            }],
          },
        }),
        target = await native.createSession(),
        { adapter, projection } = await observed(native, target.id);
      fake.queue({
        tool: {
          name: "shell",
          input: { command: "exit 7", workdir: native.directory },
        },
      });
      fake.queue({ chunks: ["shell result received"] });
      await native.prompt(target.id, "Run the shell");
      const permissions = await waitFor(
        () => native.api.permission.list({ sessionID: target.nativeID }),
        (rows) => rows.length > 0,
      );
      await native.api.permission.reply({
        sessionID: target.nativeID,
        requestID: permissions[0].id,
        decision: "once",
      });
      await waitFor(() => native.api.session.active(), (active) =>
        !active[target.nativeID]);
      const shellRows = await adapter.core.listMessages(target.id, {});
      const shell = shellRows.items.flatMap((m) =>
        m.parts
      ).find((p) => p.kind === "tool" && p.call.tool === "bash");
      assert(shell?.kind === "tool");
      assertEquals(shell.call.status, "completed");
      assertEquals(shell.call.failure?.message, "Exited with code 7");
      assert(shellRows.items.some((m) =>
        JSON.stringify(record(m) ?? {}).includes("Permission once")
      ));
      fake.queue({
        tool: {
          name: "execute",
          input: { code: "await tools.fixture.fail({})" },
        },
      });
      fake.queue({ chunks: ["execute result received"] });
      await native.prompt(target.id, "Read through execute");
      await waitFor(() =>
        native.api.session.active(), (active) =>
        !active[target.nativeID]);
      const execute = (await adapter.core.listMessages(target.id, {})).items
        .flatMap((m) =>
          m.parts
        ).find((p) =>
          p.kind === "tool" && p.call.sourceName === "execute"
        );
      assert(execute?.kind === "tool");
      assertEquals(execute.call.status, "completed");
      assert(execute.call.failure?.message);
      assert(
        execute.call.children?.some((c) =>
          c.failure
        ),
      );
      const sessionID = target.nativeID;
      const form = await native.api.session.form.create({
        sessionID,
        title: "Choose direction",
        metadata: { kind: "question" },
        fields: [{ type: "string", key: "answer", title: "Answer" }],
      });
      await native.api.session.form.reply({
        sessionID,
        formID: form.id,
        answer: { answer: "north" },
      });
      const cancelled = await native.api.session.form.create({
        sessionID,
        title: "Cancelled question",
        metadata: { kind: "question" },
        fields: [{ type: "string", key: "answer", title: "Answer" }],
      });
      await native.api.session.form.cancel({ sessionID, formID: cancelled.id });
      await waitFor(() =>
        projection.messages(), (rows) =>
        rows.some((m) =>
          JSON.stringify(record(m) ?? {}).includes("Question cancelled")
        ));
      const outcomes = (await adapter.core.listMessages(target.id, {})).items
        .filter((m) =>
          m.id.startsWith("request:")
        );
      assertEquals(outcomes.length, 3);
    }),
});
Deno.test({
  name:
    "NT2R5 stock failed background child and parent provider limit remain independent visible outcomes",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 failed child notice", async () => {
      const fake = new FakeLlm();
      fake.queue({
        tool: {
          name: "subagent",
          input: {
            description: "Usage limit child",
            prompt: "Report limit",
            agent: "explore",
            background: true,
          },
        },
      });
      fake.failRemaining("The usage limit has been reached");
      const native = await OpencodeV2Test.start(fake),
        target = await native.createSession(),
        { adapter, projection } = await observed(native, target.id);
      await native.prompt(target.id, "Delegate, then report result");
      const rows = await waitFor(() => projection.messages(), (rows) =>
        rows.some((m) => {
          const p = record(m);
          return p?.kind === "external" &&
            p.activity?.title === "Explore failed";
        }), 30000);
      const notice = rows.map(record).find((p) =>
        p?.kind === "external" && p.activity?.title === "Explore failed"
      );
      assert(notice?.kind === "external" && notice.activity?.tone === "error");
      assert(notice.activity.child?.sessionID);
      assert(
        JSON.stringify(notice.activity.body).includes(
          "The usage limit has been reached",
        ),
      );
      const snapshot = await adapter.core.listMessages(target.id, {});
      assert(snapshot.items.some((m) =>
        m.role === "assistant" &&
        m.error?.message.includes("The usage limit has been reached")
      ));
      assert(snapshot.items.some((m) =>
        JSON.stringify(record(m) ?? {}).includes("Explore failed")
      ));
      native.proxy.disconnect();
      const after = await adapter.core.listMessages(target.id, {});
      assert(after.items.some((m) =>
        JSON.stringify(record(m) ?? {}).includes("Explore failed")
      ));
    }),
});
