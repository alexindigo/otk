// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Client } from "../client.ts";
import { sessionDirectory } from "../directory.ts";
import { sessionActions } from "../session-actions.ts";
import { BootstrapDb } from "../db.ts";
import { Messages } from "../messages.ts";

Deno.test("rename resolves the target directory, encodes its ID and maps the native session", async () => {
  const calls: unknown[] = [];
  const native = {
    id: "s_id",
    directory: "/project",
    title: "New",
    projectID: "p",
    time: { created: 1, updated: 2 },
  };
  const directory = sessionDirectory(() => undefined, (id) => {
    calls.push(["resolve", id]);
    return Promise.resolve({ directory: "/project" });
  });
  const client = new Client({
    url: "http://native.invalid",
    username: "",
    password: "",
    db: "",
    heartbeattimeout: 25,
    reconnectmax: 30,
    requestms: 60000,
  }, (input, options) => {
    const url = new URL(String(input));
    calls.push([
      options?.method,
      url.pathname,
      url.searchParams.get("directory"),
      options?.body ? JSON.parse(String(options.body)) : undefined,
    ]);
    return Promise.resolve(Response.json(native));
  });
  const db = new BootstrapDb(":memory:");
  const actions = sessionActions(
    client,
    directory,
    db,
    new Messages(client, () => "/project"),
    () => Promise.resolve(undefined),
    () => {
      throw new Error("Unexpected launch");
    },
  );
  const result = await actions.rename("opcv1-s_id", "New");
  assertEquals(result.title, "New");
  assertEquals(result.directory, "/project");
  assertEquals(calls, [["resolve", "opcv1-s_id"], [
    "PATCH",
    "/session/s_id",
    "/project",
    { title: "New" },
  ]]);
  await actions.remove("opcv1-s_id");
  assertEquals(calls.slice(-2), [["resolve", "opcv1-s_id"], [
    "DELETE",
    "/session/s_id",
    "/project",
    undefined,
  ]]);
  db.close();
});
