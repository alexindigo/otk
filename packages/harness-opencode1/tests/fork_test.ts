// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { Client } from "../client.ts";
import { BootstrapDb } from "../db.ts";
import { sessionDirectory } from "../directory.ts";
import { Messages } from "../messages.ts";
import { sessionActions } from "../session-actions.ts";

Deno.test("fork translates inclusive boundaries with scalar DB and bounded API fallback, capped by pending revert", async () => {
  const file = await Deno.makeTempFile();
  const native = {
    id: "fork",
    directory: "/p",
    title: "Fork",
    time: { created: 1, updated: 2 },
  };
  const ids = ["a", "b", "c", "d"];
  const write = new DatabaseSync(file);
  write.exec(
    "CREATE TABLE session(id TEXT, directory TEXT, time_updated INT); CREATE TABLE message(id TEXT, session_id TEXT, data TEXT)",
  );
  for (const id of ids) {
    write.prepare("INSERT INTO message VALUES (?, 's/id', '{}')").run(id);
  }
  write.close();
  const db = new BootstrapDb(file);
  const calls: unknown[] = [];
  let cutoff: string | undefined;
  const client = new Client({
    url: "http://native.invalid",
    username: "",
    password: "",
    db: "",
    heartbeattimeout: 25,
    reconnectmax: 30,
  }, (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/message")) {
      assertEquals(url.searchParams.get("limit"), "100");
      const before = url.searchParams.get("before");
      const page = before ? ids.slice(0, 2) : ids.slice(2);
      return Promise.resolve(
        Response.json(page.map((id) => ({ info: { id }, parts: [] })), {
          headers: before ? {} : { "x-next-cursor": "older" },
        }),
      );
    }
    calls.push([
      url.pathname,
      url.searchParams.get("directory"),
      options?.method,
      JSON.parse(String(options?.body)),
    ]);
    return Promise.resolve(Response.json(native));
  });
  const directory = sessionDirectory(() => "/p", () => Promise.resolve(native));
  const actions = sessionActions(
    client,
    directory,
    db,
    new Messages(client, () => "/p"),
    () => Promise.resolve(cutoff),
    () => {
      throw new Error("Unexpected launch");
    },
  );
  try {
    for (const fallback of [false, true]) {
      if (fallback) db.close();
      cutoff = undefined;
      await actions.fork("s/id", "b");
      assertEquals(calls.at(-1), ["/session/s%2Fid/fork", "/p", "POST", {
        messageID: "c",
      }]);
      await actions.fork("s/id", "d");
      assertEquals(calls.at(-1), ["/session/s%2Fid/fork", "/p", "POST", {}]);
      cutoff = "c";
      for (const through of [undefined, "b", "d"]) {
        await actions.fork("s/id", through);
        assertEquals(calls.at(-1), ["/session/s%2Fid/fork", "/p", "POST", {
          messageID: "c",
        }]);
      }
      await actions.fork("s/id", "a");
      assertEquals(calls.at(-1), ["/session/s%2Fid/fork", "/p", "POST", {
        messageID: "b",
      }]);
    }
  } finally {
    db.close();
    await Deno.remove(file);
  }
});
