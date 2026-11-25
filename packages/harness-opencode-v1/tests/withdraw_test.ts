// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Client } from "../client.ts";
import { prompt } from "../prompt.ts";

const sessionID = "opcv1-ses_root";
const messageID = "msg_a";

for (
  const [name, later, busy, expected] of [
    ["deletes after abort", false, false, "withdrawn"],
    ["retries a busy delete", false, true, "withdrawn"],
    ["recognizes an answer to a later prompt", true, false, "started"],
  ] as const
) {
  Deno.test(`V1 withdrawal ${name}`, async () => {
    const calls: string[] = [];
    let fail = busy;
    const client = new Client({
      url: "http://fixture",
      username: "",
      password: "",
      db: "",
      heartbeattimeout: 25,
      reconnectmax: 30,
      requestms: 1000,
    }, (input, init) => {
      const path = new URL(String(input)).pathname.split("/").at(-1)!;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "abort") return Promise.resolve(Response.json(true));
      if (path === "status") return Promise.resolve(Response.json({}));
      if (init?.method === "DELETE") {
        if (fail) {
          fail = false;
          return Promise.resolve(
            Response.json({ _tag: "SessionBusyError" }, { status: 409 }),
          );
        }
        return Promise.resolve(Response.json(true));
      }
      return Promise.resolve(Response.json([
        ...(later
          ? [
            {
              info: { id: "msg_c", role: "assistant", parentID: "msg_b" },
              parts: [],
            },
            { info: { id: "msg_b", role: "user" }, parts: [] },
          ]
          : []),
        { info: { id: messageID, role: "user" }, parts: [] },
      ]));
    });
    const port = prompt(client, {
      resolve: () => Promise.resolve("/repo"),
      cached: () => "/repo",
      validate: () => Promise.resolve([]),
    }, () => {});
    // Reflect only so this regression can execute on the pre-feature tree.
    const withdraw = Reflect.get(port, "withdraw");
    assert(typeof withdraw === "function");
    assertEquals(await withdraw(sessionID, messageID), { state: expected });
    const round = ["POST abort", "GET status", "GET message"];
    assertEquals(
      calls,
      later ? round : [
        ...round,
        "DELETE msg_a",
        ...(busy ? [...round, "DELETE msg_a"] : []),
      ],
    );
  });
}
