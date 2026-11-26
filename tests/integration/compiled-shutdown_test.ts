// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  nativeBehavior as nativeFixture,
  type TestNative,
} from "../support/native-testing.ts";
import { preparedBinary } from "../support/prepared-binaries.ts";
import { ownedProcess } from "../support/process.ts";
import { bounded, test } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";
import { otkEndpoint } from "../support/bound-endpoint.ts";
import { WsClient } from "../support/ws-client.ts";

async function launch(oc: TestNative, port: number, level = "info") {
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
      OTK_HARNESS_TYPE: oc.kind,
      ...oc.discoveryEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "", stdout = "", stderr = "";
  const record = (data: Uint8Array) => log += new TextDecoder().decode(data);
  owner.child.stdout!.on("data", (data: Uint8Array) => {
    stdout += new TextDecoder().decode(data);
    record(data);
  });
  owner.child.stderr!.on("data", (data: Uint8Array) => {
    stderr += new TextDecoder().decode(data);
    record(data);
  });
  const closed = new Promise<void>((resolve) =>
    owner.child.once("close", () => resolve())
  );
  return {
    ...owner,
    closed,
    get log() {
      return log;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
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
    assertEquals(
      contender.stdout,
      "",
      "Stdout is reserved for machine protocols",
    );
    // WP7b requires one effective-settings diagnostic, now owned by stderr.
    const lines = contender.stderr.trim().split("\n");
    const settings = lines.filter((line) =>
      line.startsWith("SQLite settings ")
    );
    assertEquals(settings.length, 1);
    const value = JSON.parse(settings[0].slice("SQLite settings ".length));
    assertEquals(value.mmap_size, 0);
    assertEquals(typeof value.version, "string");
    const errors = lines.filter((line) =>
      !line.startsWith("config:") && !settings.includes(line)
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
    const server = await launch(fixture.oc, 0, "debug");
    const client = new WsClient((await otkEndpoint(server.child)).origin);
    await client.connect();
    await client.wait((frame) =>
      frame.t === "harness" && frame.state === "connected"
    );
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await fixture.oc.createSession(`Debug event ${i}`)).id);
    }
    if (fixture.oc.kind === "opencode-v1") {
      // Exercise two real ignored event types, twice each. Session creation
      // alone can emit only events the current adapter already understands.
      for (let i = 0; i < 2; i++) {
        await fixture.oc.request("/tui/append-prompt", {
          method: "POST",
          body: { text: `Debug event ${i}` },
        });
        await fixture.oc.request("/tui/show-toast", {
          method: "POST",
          body: { message: `Debug event ${i}`, variant: "info" },
        });
      }
      await waitFor(
        () => server.log,
        (log) =>
          log.includes("harness event ignored: tui.prompt.append") &&
          log.includes("harness event ignored: tui.toast.show"),
      );
    } else {
      // V2 session.created is recognized; prove consumption rather than require
      // V1's incidental ignored session.diff event from a different protocol.
      client.lease({ directory: fixture.oc.directory, crumbs: [], rows: ids });
      await waitFor(
        () =>
          ids.every((id) => client.entry(id)?.title.startsWith("Debug event ")),
        Boolean,
      );
    }
    await client.close();
    await server.stop();
    const ignored = server.log.split("\n").filter((line) =>
      line.startsWith("harness event ignored:")
    );
    if (fixture.oc.kind === "opencode-v1") {
      assert(ignored.length > 0, server.log);
    } else {
      assertEquals(
        ignored.length,
        0,
        "V2 recognized session events must not be logged as ignored",
      );
    }
    assertEquals(ignored.length, new Set(ignored).size, server.log);
    assertEquals(server.child.exitCode, 0, server.log);
  } finally {
    await fixture.stop();
  }
});
