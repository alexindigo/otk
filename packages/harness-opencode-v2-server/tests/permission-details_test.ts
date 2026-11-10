// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { V2Client } from "../client.ts";
import { V2Pending } from "../pending.ts";

Deno.test("V2 pending details use the asking tool input and native edit preview", async () => {
  const signal = new AbortController().signal;
  const client = new V2Client(
    { endpoint: { url: "http://127.0.0.1:42" }, version: "2.2.6", pid: 42 },
    1000,
    signal,
    () =>
      Promise.resolve(Response.json({
        data: {
          id: "msg_tool",
          type: "assistant",
          time: { created: 1 },
          content: [{
            type: "tool",
            id: "call_shell",
            name: "shell",
            state: {
              status: "running",
              input: {
                command: "printf exact-command\nprintf second",
                cwd: "/repo/sub",
              },
              metadata: {},
            },
          }],
        },
      })),
  );
  const owner = new V2Pending(() => client, () => undefined, () => {});
  owner.replacePermissions({ directory: "/repo" }, [{
    id: "per_shell",
    sessionID: "ses_root",
    action: "shell",
    resources: ["printf exact-command", "printf second"],
    source: { type: "tool", messageID: "msg_tool", id: "call_shell" },
  }, {
    id: "per_edit",
    sessionID: "ses_root",
    action: "edit",
    resources: ["README.md"],
    metadata: {
      files: [{
        file: "README.md",
        before: "before\n",
        after: "after\n",
        additions: 1,
        deletions: 1,
      }],
    },
  }]);
  const requests = await owner.permissions.listPermissions("opcv2-ses_root");
  assertEquals(requests[0].detail, {
    kind: "bash",
    command: "printf exact-command\nprintf second",
    cwd: "/repo/sub",
  });
  assertEquals(requests[1].detail.kind, "edit");
  if (requests[1].detail.kind === "edit") {
    assertEquals(
      requests[1].detail.files.map((f) => [f.path, f.additions, f.deletions]),
      [["/repo/README.md", 1, 1]],
    );
  }
});

Deno.test("V2 permission detail reads survive a complete inventory of the same native request", async () => {
  const entered = Promise.withResolvers<void>(),
    response = Promise.withResolvers<Response>();
  const client = new V2Client(
    { endpoint: { url: "http://127.0.0.1:42" }, version: "2.2.6", pid: 42 },
    1000,
    new AbortController().signal,
    () => {
      entered.resolve();
      return response.promise;
    },
  );
  const owner = new V2Pending(() => client, () => undefined, () => {});
  const raw = {
    id: "per_race",
    sessionID: "ses_root",
    action: "shell",
    resources: ["printf exact"],
    source: { type: "tool" as const, messageID: "msg_race", id: "call_race" },
  };
  owner.replacePermissions({ directory: "/repo" }, [raw]);
  const request = owner.permissions.listPermissions("opcv2-ses_root");
  await entered.promise;
  owner.replacePermissions({ directory: "/repo" }, [raw]);
  response.resolve(Response.json({
    data: {
      id: "msg_race",
      type: "assistant",
      time: { created: 1 },
      content: [{
        type: "tool",
        id: "call_race",
        name: "shell",
        state: {
          status: "running",
          input: { command: "printf exact" },
          metadata: {},
        },
      }],
    },
  }));
  assertEquals((await request)[0].detail, {
    kind: "bash",
    command: "printf exact",
  });
});
