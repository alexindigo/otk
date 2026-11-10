// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createIndex, createTranscripts, SidecarConnection } from "@otk/client";
import type { OpencodeV1Adapter } from "@otk/harness-opencode-v1";
import type { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import { start } from "../../../main.ts";
import { cfg } from "../../support/config.ts";
import { FakeLlm } from "../../support/fake-llm.ts";
import { freePort, waitFor } from "../../support/opencode.ts";
import { resources, tempDir, test } from "../../support/resources.ts";
import { SCALE } from "../../support/session-scale.ts";
import { createScale, scaleDiscovery } from "../../support/scale-native.ts";
import { V2SessionScale } from "../../support/v2-session-scale.ts";
import { MESSAGE_CASES } from "../../support/message-scale-cases.ts";
import { originFetch } from "../../support/request-wire.ts";

test("message scale fixture preserves population while supplying a 102-step reply and helper/code/diff cases", async () => {
  const root = await tempDir("mf-"), fake = new FakeLlm();
  const native = await createScale(join(root, "fixture"), root, fake, {
    messages: true,
  });
  assertEquals(native.manifest.counts, SCALE);
  const giant = native.manifest.sessions[MESSAGE_CASES.giant];
  if (native instanceof V2SessionScale) {
    const rows = (await native.native.api.message.list({
      sessionID: giant.nativeID,
      limit: 200,
      order: "desc",
    })).data;
    assertEquals(rows.filter((row) => row.type === "assistant").length, 102);
    assertEquals(
      rows.filter((row) => row.type === "user").length,
      1,
      "All 102 native assistant steps retain one source prompt",
    );
    for (
      const [key, tool] of [["helper", "subagent"], ["diff", "edit"]] as const
    ) {
      const session = native.manifest.sessions[MESSAGE_CASES[key]];
      const page = (await native.native.api.message.list({
        sessionID: session.nativeID,
        limit: 10,
        order: "desc",
      })).data;
      assert(
        page.some((row) =>
          row.type === "assistant" &&
          row.content.some((part) => part.type === "tool" && part.name === tool)
        ),
      );
    }
    const code = (await native.native.api.message.list({
      sessionID: native.manifest.sessions[MESSAGE_CASES.code].nativeID,
      limit: 10,
      order: "desc",
    })).data;
    assert(
      code.some((row) =>
        row.type === "assistant" &&
        row.content.some((part) =>
          part.type === "text" && part.text.includes("line_101_2047")
        )
      ),
    );
    return;
  }
  const rows = await native.request<
    {
      info: { role: string; parentID?: string };
      parts: { type: string; text?: string; tool?: string }[];
    }[]
  >(`/session/${giant.nativeID}/message`);
  assertEquals(rows.filter((m) => m.info.role === "assistant").length, 102);
  assertEquals(
    new Set(
      rows.filter((m) => m.info.role === "assistant").map((m) =>
        m.info.parentID
      ),
    ).size,
    1,
  );
  for (const [key, tool] of [["helper", "task"], ["diff", "edit"]] as const) {
    const session = native.manifest.sessions[MESSAGE_CASES[key]];
    const page = await native.request<{ parts: { tool?: string }[] }[]>(
      `/session/${session.nativeID}/message?limit=10`,
    );
    assert(page.some((row) => row.parts.some((p) => p.tool === tool)));
  }
  const code = native.manifest.sessions[MESSAGE_CASES.code];
  const codePage = await native.request<{ parts: { text?: string }[] }[]>(
    `/session/${code.nativeID}/message?limit=10`,
  );
  assert(
    codePage.some((row) =>
      row.parts.some((p) => p.text?.includes("line_101_2047"))
    ),
  );
});

test("real scale reports cursor reserve at 75ms collection latency across 1525 messages and reverse demand", async () => {
  const root = await tempDir("mr-"), fake = new FakeLlm();
  const native = await createScale(join(root, "fixture"), root, fake);
  const selected = native.manifest.sessions[0];
  let active = 0, maximum = 0;
  const requests: {
    path: string;
    query: string;
    cursor: string | null;
    start: number;
    end?: number;
  }[] = [];
  const samples: unknown[] = [], failures: unknown[] = [];
  const lifecycle: unknown[] = [];
  const phases: unknown[] = [];
  resources().evidence("native message reserve", () =>
    Deno.writeTextFile(
      join(root, "message-reserve.json"),
      JSON.stringify(
        {
          version: native.manifest.version,
          counts: SCALE,
          maximum,
          requests,
          samples,
          failures,
          lifecycle,
          phases,
        },
        null,
        2,
      ),
    ));
  const proxy = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      const url = new URL(req.url);
      const collection =
        /^(?:\/api)?\/session\/[^/]+\/message$/.test(url.pathname) &&
        req.method === "GET";
      const row = {
        path: url.pathname,
        query: url.search,
        cursor: url.searchParams.get(
          native instanceof V2SessionScale ? "cursor" : "before",
        ),
        start: performance.now(),
        end: undefined as number | undefined,
      };
      if (collection) {
        requests.push(row);
        maximum = Math.max(maximum, ++active);
      }
      try {
        if (collection) await new Promise((r) => setTimeout(r, 75));
        const response = await fetch(
          new Request(new URL(url.pathname + url.search, native.url), req),
        );
        if (!collection) return response;
        // Include the real native response body in the measured read lifetime.
        const headers = new Headers(response.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers,
        });
      } finally {
        if (collection) {
          active--;
          row.end = performance.now();
        }
      }
    },
  );
  resources().defer("reserve proxy", () => proxy.shutdown());
  const config = cfg();
  config.server.port = freePort();
  config.auth.type = "none";
  config.harness.url = `http://127.0.0.1:${(proxy.addr as Deno.NetAddr).port}`;
  config.harness.db = native.db;
  if (native instanceof V2SessionScale) {
    config.harness.type = "opencode-v2-server";
  }
  await scaleDiscovery(native, config.harness.url);
  config.state.path = join(root, "state");
  const app = await start(config);
  resources().defer("reserve app", () => app.stop());
  const pages = app.backend.core.listMessages.bind(app.backend.core);
  app.backend.core.listMessages = (...args) => {
    const row = {
      kind: "page",
      sessionID: args[0],
      before: args[1].before,
      at: performance.now(),
      end: undefined as number | undefined,
    };
    phases.push(row);
    return pages(...args).finally(() => {
      row.end = performance.now();
    });
  };
  const digest = (app.backend as OpencodeV1Adapter | OpencodeV2ServerAdapter)
    .digest!;
  const metadata = digest.transcriptMetadata.bind(digest);
  digest.transcriptMetadata = (...args) => {
    const row = {
      kind: "metadata",
      sessionID: args[0],
      at: performance.now(),
      end: undefined as number | undefined,
    };
    phases.push(row);
    return metadata(...args).finally(() => {
      row.end = performance.now();
    });
  };
  const index = createIndex();
  const target = { sidecarId: "scale", sessionID: selected.id };
  const owner = createTranscripts({
    connection: () => connection,
    entry: (server, id) => index.get(server, id),
  });
  resources().defer("reserve owner", () => owner.stop());
  const connection = new SidecarConnection(
    `http://127.0.0.1:${config.server.port}`,
    {
      status() {},
      frame(frame) {
        if (
          frame.t === "request.result" && !frame.outcome.ok ||
          frame.t === "request.rejected"
        ) failures.push(frame);
        let accepted = true;
        if (frame.t === "index.snapshot" || frame.t === "index.patch") {
          accepted = index.receive("scale", frame);
          if (!accepted) connection.send({ t: "resnapshot" });
        }
        // reserve lifecycle: observe authority transitions, never retained bodies.
        const state = () => {
          const value = owner.get(target)?.state;
          return value && {
            count: value.messageIDs.length,
            continuity: value.continuity,
            loading: value.pageLoading,
            clock: value.clock,
          };
        };
        const before = state();
        owner.receive("scale", frame, accepted);
        const after = state();
        if (
          frame.t === "transcript.invalidated" ||
          frame.t === "bootstrap.complete" || frame.t === "welcome" ||
          before?.count !== after?.count ||
          before?.continuity !== after?.continuity
        ) {
          lifecycle.push({
            at: performance.now(),
            kind: frame.t,
            before,
            after,
          });
        }
      },
    },
    {
      fetcher: originFetch(`http://127.0.0.1:${config.server.port}`),
      socket: (url) =>
        Reflect.construct(WebSocket, [url, {
          headers: { Origin: `http://127.0.0.1:${config.server.port}` },
        }]) as WebSocket,
    },
  );
  resources().defer("reserve connection", () => connection.stop());
  connection.view({
    directory: selected.directory,
    selected: selected.id,
    crumbs: [],
    rows: native.manifest.sessions.slice(0, 251).map((session) => session.id),
  });
  await connection.connect();
  await waitFor(
    () => connection.messages && index.get("scale", selected.id),
    Boolean,
  );
  owner.setDemand({
    scope: { sidecarId: "scale", directory: selected.directory },
    sessions: native.manifest.sessions.slice(0, 251).map((s) => ({
      sidecarId: "scale",
      sessionID: s.id,
    })),
    selected: target,
  });
  const resource = owner.get(target)!;
  resources().defer(
    "reserve observation",
    resource.subscribe((state) => {
      if (state.error) {
        failures.push({
          at: performance.now(),
          continuity: state.continuity,
          error: state.error,
        });
        console.info("Scale baseline error", state.error);
      }
    }),
  );
  await waitFor(() => resource.state.messageIDs.length, (n) => n >= 20);
  const messageID = (rank: number) =>
    `msg_scale${
      String(rank).padStart(native instanceof V2SessionScale ? 12 : 9, "0")
    }`;
  resource.viewport({ first: messageID(1520), last: messageID(1524) });
  await waitFor(() => resource.state.messageIDs.length, (n) => n >= 30);
  const begun = performance.now();
  for (let step = 0, rank = 1520; rank >= 0; step++) {
    const due = begun + step * 200;
    await new Promise((r) =>
      setTimeout(r, Math.max(0, due - performance.now()))
    );
    const loaded = resource.state.messageIDs;
    const oldest = Number(loaded[0].slice("msg_scale".length));
    const requestedFirst = Math.max(0, rank);
    // Real scrolling can reach the acquired edge, never an unrendered ID.
    // Keep reporting reserve misses without turning cadence into lost demand.
    const first = Math.max(oldest, requestedFirst);
    const last = Math.min(1524, first + 4);
    const ready = first - oldest;
    samples.push({
      at: performance.now(),
      requestedFirst,
      first,
      last,
      oldest,
      ready,
      loading: resource.state.pageLoading,
      acquired: loaded.length,
      requiredReady: !!resource.state.messagesByID[messageID(first)],
      requestedReady: !!resource.state.messagesByID[messageID(requestedFirst)],
    });
    if (ready < 10 && oldest !== 0) {
      console.info("Native reserve cadence measurement", {
        first,
        oldest,
        ready,
      });
    }
    resource.viewport({ first: messageID(first), last: messageID(last) });
    rank = first - 10;
  }
  await waitFor(() => resource.state.messageIDs.length, (n) => n === 1525);
  assertEquals(resource.state.olderCursor, null);
  for (let rank = 0; rank <= 1520; rank += 10) {
    const before = requests.length;
    resource.viewport({
      first: messageID(rank),
      last: messageID(Math.min(1524, rank + 4)),
    });
    assert(resource.state.messagesByID[messageID(rank)]);
    assertEquals(
      requests.length,
      before,
      "reverse visits borrow acquired pages",
    );
  }
  for (let rank = 0; rank < 1525; rank++) {
    const message = resource.state.messagesByID[messageID(rank)];
    assertEquals(message.role, rank % 2 ? "assistant" : "user");
    const count = 3 + (rank < 1097 ? 1 : 0);
    if (native instanceof V2SessionScale) {
      const texts = message.parts.filter((part) => part.kind === "text");
      assertEquals(texts.length, rank % 2 ? count : 1);
      assertEquals(
        message.parts.filter((part) => part.kind === "step").map((part) =>
          part.phase
        ),
        rank % 2 ? ["start", "finish"] : [],
      );
      for (let part = 0; part < count; part++) {
        assert(
          JSON.stringify(texts[rank % 2 ? part : 0]).includes(
            `Scale fixture 0/${rank}/${part}`,
          ),
        );
      }
      continue;
    }
    assertEquals(message.parts.length, count);
    for (let part = 0; part < count; part++) {
      assert(
        JSON.stringify(message.parts[part]).includes(
          `Scale fixture 0/${rank}/${part}`,
        ),
      );
    }
  }
  assert(maximum <= 4, `aggregate page ceiling ${maximum}`);
  assertEquals(
    requests.filter((r) =>
      r.path ===
        `${
          native instanceof V2SessionScale ? "/api" : ""
        }/session/${selected.nativeID}/message`
    )
      .length,
    153,
  );
  assertEquals(
    failures,
    [],
    "Admitted paging work must not produce false failures",
  );
});
