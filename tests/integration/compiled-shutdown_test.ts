// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { nativeFixture } from "../support/native-fixture.ts";
import { preparedBinary } from "../support/prepared-binaries.ts";
import { ownedProcess } from "../support/process.ts";
import { bounded, test } from "../support/resources.ts";
import { freePort, type OpencodeTest, waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";

async function launch(
  oc: Pick<OpencodeTest, "root" | "url" | "db">,
  port: number,
  level = "info",
) {
  const binary = await preparedBinary();
  const env = Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([key]) =>
      !key.startsWith("OTK_")
    ),
  );
  const owner = ownedProcess(binary, [], {
    env: {
      ...env,
      OTK_AUTH_TYPE: "none",
      OTK_LOG_LEVEL: level,
      OTK_STATE_PATH: join(oc.root, `process-${port}`),
      OTK_SERVER_PORT: String(port),
      OTK_HARNESS_URL: oc.url,
      OTK_HARNESS_DB: oc.db,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const record = (data: Uint8Array) => log += new TextDecoder().decode(data);
  owner.child.stdout!.on("data", record);
  owner.child.stderr!.on("data", record);
  const closed = new Promise<void>((resolve) =>
    owner.child.once("close", () => resolve())
  );
  return {
    ...owner,
    closed,
    get log() {
      return log;
    },
  };
}

test("compiled SIGINT exits cleanly and occupied port reports only its failure", async () => {
  await preparedBinary();
  const fixture = await nativeFixture();
  try {
    const server = await fixture.sidecar();
    const contender = await launch(fixture.oc, server.port);
    await bounded("occupied port exits", contender.closed);
    const log = contender.log;
    assertEquals(contender.child.exitCode, 1, log);
    const errors = log.trim().split("\n").filter((line) =>
      !line.startsWith("config:")
    );
    assertEquals(errors, [
      `OTK: Port ${server.port} is in use; configure OTK_SERVER_PORT`,
    ]);
    const closed = new Promise<void>((resolve) =>
      server.process.once("close", () => resolve())
    );
    // ChildProcess.kill eagerly sets signalCode in Deno's Node compatibility
    // layer, even when the child handles the signal and exits 0. Keep the
    // observation kernel-derived by delivering the signal to the PID directly.
    Deno.kill(server.process.pid!, "SIGINT");
    await bounded("clean SIGINT exit", closed);
    assertEquals(server.process.exitCode, 0, server.log);
    assertEquals(server.process.signalCode, null, server.log);
    assert(
      !/AbortError|StoppedError|warn|session digest:|\n\s+at /.test(server.log),
      server.log,
    );
  } finally {
    await fixture.stop();
  }
});

test("compiled debug logging reports each ignored real native event type once", async () => {
  await preparedBinary();
  const fixture = await nativeFixture();
  try {
    const port = await freePort();
    const server = await launch(fixture.oc, port, "debug");
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).json(),
      (health) => health.ok === true,
    );
    const client = new WsClient(`http://127.0.0.1:${port}`);
    await client.connect();
    await client.wait((frame) =>
      frame.t === "harness" && frame.state === "connected"
    );
    for (let i = 0; i < 4; i++) {
      await fixture.oc.request("/session", {
        method: "POST",
        body: { title: `Debug event ${i}` },
      });
    }
    await waitFor(
      () => server.log,
      (log) => log.includes("harness event ignored:"),
    );
    await client.close();
    await server.stop();
    const ignored = server.log.split("\n").filter((line) =>
      line.startsWith("harness event ignored:")
    );
    assert(ignored.length > 0, server.log);
    assertEquals(ignored.length, new Set(ignored).size, server.log);
    assertEquals(server.child.exitCode, 0, server.log);
  } finally {
    await fixture.stop();
  }
});
