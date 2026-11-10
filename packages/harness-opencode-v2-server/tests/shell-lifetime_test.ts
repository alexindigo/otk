// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { OperationContext } from "@otk/protocol";
import { V2Client } from "../client.ts";
import { sessionActions } from "../session-actions.ts";

Deno.test("V2 shell completion belongs to the shell exchange, not a nonexistent session execution", async () => {
  const paths: string[] = [];
  const client = new V2Client(
    { endpoint: { url: "http://fixture" }, version: "2.2.6", pid: 1 },
    1000,
    new AbortController().signal,
    (request) => {
      const path =
        new URL(request instanceof Request ? request.url : String(request))
          .pathname;
      paths.push(path);
      return Promise.resolve(
        path.endsWith("/shell")
          ? new Response(null, { status: 204 })
          : Response.json({ message: "No execution to wait for" }, {
            status: 500,
          }),
      );
    },
  );
  const operation: OperationContext = {
    signal: new AbortController().signal,
    key: { key: "shell", clientID: "client", window: "window" },
    progress() {},
    beforeEffect: () => Promise.resolve(),
    checkpoint: () => Promise.resolve(),
    wait: (value) => value,
  };
  await sessionActions({
    client: () => client,
    observed() {},
    removed: () => Promise.resolve(),
  }).shell!.shell({ sessionID: "opcv2-ses_shell", command: "true" }, operation);
  assertEquals(paths, ["/api/session/ses_shell/shell"]);
});
