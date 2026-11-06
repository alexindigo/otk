// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { DigestBridge } from "../../core/digest/bridge.ts";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { resources, tempDir, test } from "../support/resources.ts";

test("sessions admitted behind a held native catalog all publish ready digests", async () => {
  const oc = await OpencodeTest.start(new FakeLlm());
  const statePath = await tempDir("catalog-admission-");
  const release = Promise.withResolvers<void>();
  let holding = false, captured = false;
  const samples: string[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      url.host = new URL(oc.url).host;
      const response = await fetch(url, { signal: request.signal });
      if (
        holding && !captured && url.pathname === "/experimental/session" &&
        url.searchParams.get("limit") === "1"
      ) {
        // Hold delivery of the actual stock-native bytes after enumeration.
        const bytes = await response.arrayBuffer();
        samples.push(new TextDecoder().decode(bytes));
        captured = true;
        await release.promise;
        return new Response(bytes, {
          status: response.status,
          headers: response.headers,
        });
      }
      return response;
    },
  );
  resources().defer("native catalog proxy", () => server.shutdown());
  const ready = new Set<string>();
  const diagnostics: string[] = [];
  const bridge = new DigestBridge({
    statePath,
    provider: "opencode-v1",
    native: {
      harness: {
        url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
        username: "",
        password: "",
        db: oc.db,
        heartbeattimeout: 25,
        reconnectmax: 30,
        requestms: 60000,
      },
      index: { days: 30 },
      attachments: cfg().attachments,
    },
    policy: cfg().digest,
    publish: (value) => {
      if (value.delta.summary.state === "ready") ready.add(value.sessionID);
      else ready.delete(value.sessionID);
    },
    diagnostic: (error) => diagnostics.push(String(error)),
  });
  try {
    bridge.scope("viewer", { sessions: [] });
    await bridge.start();
    await bridge.catalog(1, new AbortController().signal);
    holding = true;
    const trigger = await oc.session("/session", {
      method: "POST",
      body: { title: "Refresh trigger" },
    });
    bridge.observe(1, [{
      sessionID: trigger.id,
      revision: 1,
      reason: "metadata",
    }]);
    await waitFor(() => captured, Boolean);
    const working = await oc.session("/session", {
      method: "POST",
      body: { title: "Background working" },
    });
    const blocked = await oc.session("/session", {
      method: "POST",
      body: { title: "Background blocked" },
    });
    const ids = [working.id, blocked.id];
    bridge.observe(
      1,
      ids.map((sessionID, i) => ({
        sessionID,
        revision: i + 2,
        reason: "metadata" as const,
      })),
    );
    const derived = new DatabaseSync(join(statePath, "digest.db"), {
      readOnly: true,
    });
    try {
      // Observe actual committed admission while the older inventory is held.
      await waitFor(() =>
        derived.prepare(
          "SELECT count(*) AS n FROM opcv1_scan WHERE session_id IN (?,?) AND dirty=1",
        ).get(...ids)?.n, (count) => count === 2);
      assertEquals(samples.length, 1);
      assertEquals(ids.every((id) => !ready.has(id)), true);
      release.resolve();
      await waitFor(() => ready.has(trigger.id), Boolean);
      await waitFor(
        () => ids.filter((id) => ready.has(id)),
        (value) => value.length === 2,
      );
      assertEquals(diagnostics, []);
    } finally {
      await Deno.writeTextFile(
        join(statePath, "catalog-admission.json"),
        JSON.stringify(
          {
            trigger,
            working,
            blocked,
            samples,
            ready: [...ready],
            diagnostics,
            sessions: derived.prepare(
              "SELECT id,title,state,revision FROM digest_sessions",
            ).all(),
            scans: derived.prepare("SELECT * FROM opcv1_scan").all(),
          },
          null,
          2,
        ),
      );
      derived.close();
    }
  } finally {
    release.resolve();
    await bridge.stop();
  }
});
