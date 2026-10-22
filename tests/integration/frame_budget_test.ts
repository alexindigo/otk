// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";

test("oversized total receives an immediate RPC-id error and leaves the connection usable", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const server = await SidecarTest.start(oc), client = new WsClient(server.url);
  try {
    await client.connect();
    const upload = {
      kind: "file",
      source: "upload",
      name: "part.txt",
      mime: "text/plain",
      dataBase64: "AAAA".repeat(17 * 1024 * 1024 / 4),
    };
    const serialized = JSON.stringify({
      t: "rpc",
      id: "oversized",
      method: "session.prompt",
      params: { sessionID: "unused", parts: [upload, upload, upload, upload] },
    });
    // Deno's native parser closes a single physical frame at 64 MiB before
    // dispatch. Fragment the same oversized logical message to exercise OTK's
    // request-id rejection at the application boundary.
    const fragmentBytes = 8 * 1024 * 1024;
    for (let offset = 0; offset < serialized.length; offset += fragmentBytes) {
      client.ws.send(serialized.slice(offset, offset + fragmentBytes), {
        fin: offset + fragmentBytes >= serialized.length,
      });
    }
    const frame = await client.wait(
      (frame) => frame.t === "rpc.result" && frame.id === "oversized",
      5000,
    );
    assert(frame.t === "rpc.result" && !frame.ok);
    assertEquals(frame.error.code, "frame");
    assert(frame.error.message.includes("64 MiB"));
    assertEquals(fake.requests.length, 0);
    await client.rpc("prefs.get", {});
  } finally {
    await client.close();
    await server.stop();
    await oc.stop();
    await fake.stop();
  }
});
