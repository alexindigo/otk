// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Client, NativeRequestFailure } from "../client.ts";

Deno.test("V1 selects native semantic reasons independently of legacy display copy", async () => {
  const password = "fixture-configured-credential";
  for (
    const message of [
      "The model quota was reached",
      `Unexpected credential ${password}`,
      "Authorization: Bearer fixture-token",
    ]
  ) {
    const client = new Client(
      {
        url: "http://fixture",
        username: "fixture",
        password,
        db: "",
        heartbeattimeout: 25,
        reconnectmax: 30,
        requestms: 60000,
      },
      () =>
        Promise.resolve(
          Response.json({
            name: "UnknownError",
            data: { message, token: password },
          }, { status: 400 }),
        ),
    );
    const failure = await assertRejects(
      () => client.json("/session/fixture/revert"),
      NativeRequestFailure,
    );
    assertEquals(failure.facts?.status, 400);
    if (message === "The model quota was reached") {
      assertEquals(failure.facts?.reason, message);
    } else {
      assert(failure.facts?.reason?.includes("credential"));
      assert(!JSON.stringify(failure.failure).includes(password));
      assert(!JSON.stringify(failure.failure).includes("fixture-token"));
    }
  }
});
