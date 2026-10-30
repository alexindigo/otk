// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { HelperSummary } from "@otk/protocol";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import { resources, tempDir, test } from "../../support/resources.ts";
import { waitFor } from "../../support/opencode.ts";

test("live catalog discovery resumes helper demand admitted before its metadata existed", async () => {
  const statePath = await tempDir("helper-discovery-");
  const raw = (id: string, parentID?: string) => ({
    id,
    parentID,
    directory: "/project",
    projectID: "p",
    title: id,
    time: { created: 1, updated: 2 },
  });
  let catalogs = 0,
    discover = false,
    hintFinished = false,
    beforeHint = Infinity;
  const summaries = new Map<string, string>();
  const helpers = new Map<string, HelperSummary>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/global/health") return Response.json({ healthy: true });
      if (path === "/experimental/session") {
        catalogs++;
        return Response.json(
          discover ? [raw("root"), raw("child", "root")] : [raw("root")],
        );
      }
      if (path === "/session/root/message") return Response.json([]);
      if (path === "/session/child") return Response.json(raw("child", "root"));
      if (path === "/session/child/message") {
        return Response.json([
          {
            info: {
              id: "user",
              sessionID: "child",
              role: "user",
              time: { created: 1 },
            },
            parts: [],
          },
          {
            info: {
              id: "assistant",
              sessionID: "child",
              role: "assistant",
              parentID: "user",
              agent: "general",
              modelID: "scripted",
              providerID: "fake",
              cost: 0,
              tokens: {
                input: 1,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              time: { created: 2, completed: 3 },
            },
            parts: [{
              id: "tool",
              messageID: "assistant",
              sessionID: "child",
              type: "tool",
              tool: "bash",
              state: {
                status: "running",
                title: "Waiting command",
                time: { start: 2 },
              },
            }],
          },
        ]);
      }
      throw new Error(`Unexpected helper discovery read ${request.url}`);
    },
  );
  resources().defer("helper discovery HTTP", () => server.shutdown());
  const bridge = new DigestBridge({
    statePath,
    provider: "opencode-v1",
    native: {
      harness: {
        url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
        username: "",
        password: "",
        db: statePath + "/absent.db",
        heartbeattimeout: 25,
        reconnectmax: 30,
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
    publish(value) {
      summaries.set(value.sessionID, value.delta.summary.state);
      if (value.delta.helper) helpers.set(value.sessionID, value.delta.helper);
    },
    pressure(value) {
      if (catalogs > beforeHint && value.queued === 1) hintFinished = true;
    },
  });
  try {
    await bridge.start();
    await bridge.catalog(1, new AbortController().signal);
    await waitFor(
      () => summaries.get("opcv1-root"),
      (state) => state === "ready",
    );
    beforeHint = catalogs;
    bridge.observe(1, [{
      sessionID: "opcv1-child",
      revision: 1,
      reason: "helper-hint",
    }]);
    // The first admitted helper turn has really completed without a catalog
    // identity. No timer or second hint is allowed to repair that lost demand.
    await waitFor(() => hintFinished, Boolean);
    await bridge.transcriptMetadata(
      "opcv1-root",
      [],
      new AbortController().signal,
    );
    assertEquals(helpers.has("opcv1-child"), false);
    discover = true;
    bridge.observe(1, [{
      sessionID: "opcv1-child",
      revision: 2,
      reason: "messages",
    }]);
    await waitFor(
      () => summaries.get("opcv1-child"),
      (state) => state === "ready",
    );
    await waitFor(
      () => helpers.get("opcv1-child"),
      (value) => value?.state === "ready",
      5000,
    );
    assertEquals(helpers.get("opcv1-child")?.toolCount, 1);
    assertEquals(helpers.get("opcv1-child")?.current?.name, "bash");
  } finally {
    console.info("Helper discovery receipt", {
      catalogs,
      beforeHint,
      hintFinished,
      summaries: [...summaries],
      helpers: [...helpers],
    });
    await bridge.stop();
  }
});
