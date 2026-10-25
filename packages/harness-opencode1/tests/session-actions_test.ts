// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Client } from "../client.ts";
import { sessionDirectory } from "../directory.ts";
import { sessionActions } from "../session-actions.ts";

Deno.test("rename resolves the target directory, encodes its ID and maps the native session", async () => {
  const calls: unknown[] = [];
  const native = {
    id: "s/id",
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
  }, (input, options) => {
    const url = new URL(String(input));
    calls.push([
      options?.method,
      url.pathname,
      url.searchParams.get("directory"),
      JSON.parse(String(options?.body)),
    ]);
    return Promise.resolve(Response.json(native));
  });
  const result = await sessionActions(client, directory).rename("s/id", "New");
  assertEquals(result.title, "New");
  assertEquals(result.directory, "/project");
  assertEquals(calls, [["resolve", "s/id"], [
    "PATCH",
    "/session/s%2Fid",
    "/project",
    { title: "New" },
  ]]);
});
