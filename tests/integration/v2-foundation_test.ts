// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { selectHarness } from "../../harness-selection.ts";
import {
  discoverV2,
  OpencodeV2ServerAdapter,
  opencodeV2SessionID,
} from "@otk/harness-opencode-v2-server";
import type { HarnessSink } from "@otk/harness";
import type {
  InboxBaseline,
  SessionListPage,
  SessionMetadata,
} from "@otk/protocol";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { nativeKind } from "../support/native.ts";
import { resources, withResources } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test({
  name:
    "OC2F3 wildcard managed registration reaches worker reads and live events",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 wildcard discovery", async () => {
      const fake = new FakeLlm();
      fake.queue({ chunks: ["one", "two", "three", "four"], delay: 300 });
      const native = await OpencodeV2Test.start(fake, { hostname: "0.0.0.0" });
      const text = await Deno.readTextFile(native.registration);
      assertEquals(new URL(JSON.parse(text).url).hostname, "0.0.0.0");
      const target = await native.createSession("Wildcard discovery");
      // Point the compiled consumer and its worker at the real managed record,
      // not the fixture's loopback fault proxy registration.
      const app = await SidecarTest.start({
        ...native,
        discoveryEnv: {
          ...native.discoveryEnv,
          XDG_STATE_HOME: native.root + "/state",
        },
      });
      const ws = new WsClient(app.url);
      await ws.connect();
      const page = await ws.rpc<SessionListPage>("sessions.list", {
        directory: native.directory,
        parentID: null,
      });
      assertEquals(page.load.state, "complete");
      assertEquals(page.items.map((row) => row.id), [target.id]);
      await native.prompt(target.id, "verify wildcard live events");
      const status = async () =>
        (await ws.rpc<InboxBaseline>("inbox.get", {})).inbox.summaries
          ?.[native.directory].status;
      await waitFor(status, (value) => value === "working");
      await waitFor(status, (value) => value === "finished", 30_000);
      assertEquals(await Deno.readTextFile(native.registration), text);
      await ws.close();
      await app.stop();
      assertEquals(native.process.exitCode, null);
    }),
});

Deno.test({
  name:
    "OC2F1 subscribed reconnect restores active executions and pending requests",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 foundation", async () => {
      const fake = new FakeLlm();
      fake.queue({
        chunks: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
        delay: 500,
      });
      const native = await OpencodeV2Test.start(fake);
      const target = await native.createSession();
      const config = cfg();
      const adapter = new OpencodeV2ServerAdapter({
        serviceFile: native.serviceFile,
        harness: config.harness,
        messages: config.messages,
      });
      resources().defer("V2 adapter", () => adapter.core.stop());
      const entries = new Map<string, SessionMetadata>();
      let bootstraps = 0;
      const sink: HarnessSink = {
        connection: () => {},
        indexReset: () => {},
        indexRemove: () => {},
        indexUpsert: (entry) => {
          entries.set(entry.id, entry);
        },
        content: () => {},
        invalidate: () => {},
        bootstrapComplete: () => {
          bootstraps++;
        },
      };
      await adapter.core.start(sink);
      assertEquals(adapter.core.kind, "opencode-v2-server");
      assertEquals(adapter.core.version, "2.2.6");
      assertEquals(
        await adapter.core.identities([
          opencodeV2SessionID.encode("ses_missing"),
        ]),
        [],
      );
      await native.prompt(target.id, "produce fixture text");
      await waitFor(
        () => entries.get(target.id)?.status,
        (status) => status === "busy",
      );
      native.proxy.disconnect();
      await waitFor(() => bootstraps, (count) => count === 2);
      assertEquals(entries.get(target.id)?.status, "busy");
      await waitFor(
        () => entries.get(target.id)?.status,
        (status) => status === "idle",
        30_000,
      );
      const messages = await native.api.message.list({
        sessionID: target.nativeID,
        limit: 10,
        order: "desc",
      });
      assertEquals(JSON.stringify(messages).includes("ABCDEFGHIJ"), true);
      const form = await native.api.session.form.create({
        sessionID: target.nativeID,
        title: "Foundation pending",
        fields: [{ key: "name", type: "string", title: "Name" }],
      });
      native.proxy.disconnect();
      await waitFor(() => bootstraps, (count) => count >= 3);
      await waitFor(
        () => entries.get(target.id)?.attention.questions,
        (count) => count === 1,
      );
      await native.api.session.form.reply({
        sessionID: target.nativeID,
        formID: form.id,
        answer: { name: "fixture" },
      });
      await waitFor(
        () => entries.get(target.id)?.attention.questions,
        (count) => count === 0,
      );
      const asking = native.nativeApi.permission.create({
        sessionID: target.nativeID,
        action: "shell",
        resources: ["echo foundation"],
      });
      // The ask stays on the direct native channel, not the faulted OTK proxy.
      const outcome = asking.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const pending = await waitFor(
        () => native.nativeApi.permission.list({ sessionID: target.nativeID }),
        (rows) => rows.length === 1,
      );
      const beforePermissionReconnect = bootstraps;
      native.proxy.disconnect();
      await waitFor(
        () => bootstraps,
        (count) => count > beforePermissionReconnect,
      );
      await waitFor(
        () => entries.get(target.id)?.attention.permissions,
        (count) => count === 1,
      );
      await native.replyPermission(target.id, pending[0].id, "once");
      assertEquals("value" in await outcome, true);
      await waitFor(
        () => entries.get(target.id)?.attention.permissions,
        (count) => count === 0,
      );
      await adapter.core.stop();
      assertEquals(native.process.exitCode, null); // OTK never owns the native lifecycle.
    }),
});

Deno.test({
  name:
    "OC2F2 selected source/compiled OTK consumer discovers the managed fixture without owning it",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 application discovery", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm());
      const registration = JSON.parse(
        await Deno.readTextFile(native.serviceFile),
      );
      const wrong = native.root + "/wrong-service.json";
      await Deno.writeTextFile(
        wrong,
        JSON.stringify({ ...registration, password: "deliberately-wrong" }),
      );
      await assertRejects(
        () => discoverV2(wrong),
        Error,
        "authentication failed (401)",
      );
      await assertRejects(
        () => discoverV2(native.root + "/missing-service.json"),
        Error,
        "No opencode service is running",
      );
      const app = await SidecarTest.start(native);
      const health = await (await fetch(app.url + "/api/health")).json();
      assertEquals(health.harness, {
        kind: "opencode-v2-server",
        version: "2.2.6",
      });
      const ws = new WsClient(app.url);
      await ws.connect();
      const welcome = await ws.wait((frame) => frame.t === "welcome");
      if (welcome.t !== "welcome") throw new Error("Missing V2 welcome");
      assertEquals(welcome.sidecar.harness.kind, "opencode-v2-server");
      await ws.close();
      await app.stop();
      assertEquals(native.process.exitCode, null);
    }),
});

Deno.test({
  name: "OC2PE probe failures preserve fallback and registration provenance",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 probe diagnostics", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm());
      const registration = JSON.parse(
        await Deno.readTextFile(native.serviceFile),
      );
      const state = native.root + "/absent-state";
      const missing = state + "/opencode/service.json";
      const config = {
        ...cfg().harness,
        type: "auto",
        url: registration.url,
        password: "",
      };
      const env = { HOME: native.root, XDG_STATE_HOME: state };
      const unauthorized = await assertRejects(
        () => selectHarness(config, env),
        Error,
        "401",
      );
      assertStringIncludes(
        unauthorized.message,
        `no opencode service registration at ${missing}`,
      );
      assertStringIncludes(unauthorized.message, registration.url);
      assertStringIncludes(
        unauthorized.message,
        "no credentials were sent (harness.url fallback)",
      );

      const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const url = `http://127.0.0.1:${closed.addr.port}`;
      closed.close();
      const unreachable = await assertRejects(
        () => selectHarness({ ...config, url }, env),
        Error,
      );
      assertStringIncludes(
        unreachable.message,
        `no opencode service registration at ${missing}`,
      );
      assertStringIncludes(unreachable.message, url);
      assertStringIncludes(unreachable.message, "unreachable");
      assertStringIncludes(
        unreachable.message,
        "no credentials were sent (harness.url fallback)",
      );

      await Deno.mkdir(state + "/opencode", { recursive: true });
      await Deno.writeTextFile(
        missing,
        JSON.stringify({ ...registration, password: "wrong-password" }),
      );
      const wrong = await assertRejects(
        () => selectHarness({ ...config, type: "opencode-v2-server" }, env),
        Error,
        "401",
      );
      assertStringIncludes(wrong.message, registration.url);
      assertStringIncludes(wrong.message, `registration ${missing}`);
      assertEquals(wrong.message.includes("wrong-password"), false);

      const replacement = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        () =>
          Response.json({
            version: registration.version,
            pid: registration.pid + 1,
          }, { status: 401 }),
      );
      try {
        const url = `http://127.0.0.1:${replacement.addr.port}`;
        await Deno.writeTextFile(
          missing,
          JSON.stringify({ ...registration, url }),
        );
        const stale = await assertRejects(
          () => selectHarness(config, env),
          Error,
          "Stale",
        );
        assertStringIncludes(stale.message, url);
        assertStringIncludes(stale.message, `registration ${missing}`);
        assertEquals(
          stale.message.includes("authentication failed (401)"),
          false,
        );
      } finally {
        await replacement.shutdown();
      }
      assertEquals(native.process.exitCode, null);
    }),
});
