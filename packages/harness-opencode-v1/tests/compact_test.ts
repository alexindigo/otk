// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Client } from "../client.ts";
import { BootstrapDb } from "../db.ts";
import { sessionDirectory } from "../directory.ts";
import { Messages } from "../messages.ts";
import { sessionActions } from "../session-actions.ts";

Deno.test("compact launches an owned unbounded summarize request with the captured model and directory", async () => {
  const client = new Client({
    url: "http://native.invalid",
    username: "",
    password: "",
    db: "",
    heartbeattimeout: 25,
    reconnectmax: 30,
    requestms: 60000,
  }, () => {
    throw new Error("Only the launch owner may send this request");
  });
  const db = new BootstrapDb(":memory:");
  const launched: unknown[] = [];
  const actions = sessionActions(
    client,
    sessionDirectory(
      () => "/captured",
      () => Promise.resolve({ directory: "/wrong" }),
    ),
    db,
    new Messages(client, () => "/captured"),
    () => Promise.resolve(undefined),
    (...args) => {
      launched.push(args);
    },
  );
  try {
    await actions.compact("opcv1-s_id", { provider: "chosen", model: "m/id" });
    assertEquals(launched, [[
      "opcv1-s_id",
      "compact",
      "/session/s_id/summarize",
      {
        method: "POST",
        query: { directory: "/captured" },
        classification: "effect",
        body: { providerID: "chosen", modelID: "m/id" },
      },
    ]]);
  } finally {
    db.close();
  }
});
