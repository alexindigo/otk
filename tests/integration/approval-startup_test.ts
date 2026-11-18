// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { OtkDb, permissionMigrations, PermissionStore } from "@otk/store";
import type { PermissionActivityPage } from "@otk/protocol";
import { nativeFixture } from "../support/native-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

test("@attention @transport pending startup permission is auto-approved once after native bootstrap", async () => {
  const stack = await nativeFixture({ "*": "ask" });
  const { oc, fake } = stack;
  let client: WsClient | undefined;
  try {
    const session = await oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Startup automatic permission" },
    });
    fake.queue({
      tool: {
        name: "bash",
        input: {
          command: "printf fx32-startup-output",
          description: "Startup permission probe",
        },
      },
    }, { chunks: ["Startup permission completed"] });
    await oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: {
        parts: [{ type: "text", text: "Run the startup permission probe" }],
      },
    });
    const pending = await waitFor(
      () => oc.request<{ id: string }[]>("/permission"),
      (rows) => rows.length === 1,
    );
    const state = join(oc.root, "startup-auto-state");
    const db = new OtkDb(state, [permissionMigrations], { busyms: 5000 });
    try {
      new PermissionStore(db).setAuto(session.id, true);
    } finally {
      db.close();
    }
    // OTK has never connected to this native. Its stored policy must apply to
    // the initial pending inventory, without a browser or a changed fingerprint.
    const server = await stack.sidecar({ state: { path: state } });
    client = new WsClient(server.url);
    await client.connect();
    await waitFor(
      () => oc.request<unknown[]>("/permission"),
      (rows) => rows.length === 0,
    );
    const activity = await waitFor(
      () =>
        client!.rpc<PermissionActivityPage>("permission.activity", {
          sessionID: session.id,
        }),
      (page) => page.entries.some((row) => row.outcome === "confirmed"),
    );
    assertEquals(
      activity.entries.map((row) => ({
        id: row.request.id,
        outcome: row.outcome,
        source: row.source,
      })),
      [
        { id: pending[0].id, outcome: "confirmed", source: "auto" },
      ],
    );
    const history = await waitFor(
      () =>
        oc.request<
          { parts: { tool?: string; state?: { output?: string } }[] }[]
        >(`/session/${session.id}/message`),
      (messages) =>
        messages.some((message) =>
          message.parts.some((part) =>
            part.state?.output === "fx32-startup-output"
          )
        ),
    );
    assert(history.length > 0);
    assertEquals(
      server.log.includes("permission auto reply:"),
      false,
      server.log,
    );
  } finally {
    await client?.close();
    await stack.stop();
  }
});
