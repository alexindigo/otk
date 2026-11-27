// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { browserSessionID } from "../support/browser-native.ts";
import { nativeVersion } from "../support/native.ts";
import { tempDir, test } from "../support/resources.ts";

test("controller records ownership even when profile admission fails before acquiring a native", async () => {
  const root = await tempDir("controller-admission-"),
    record = join(root, "owned.json");
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "tests/support/fixture-controller.ts"],
    env: { OTK_TEST_CONTROLLER_RECORD: record },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        id: "reject",
        command: "start",
        params: { profile: "not-a-profile", version: "2.2.6" },
      }) + "\n",
    ),
  );
  await writer.close();
  const result = await child.output();
  const frame = JSON.parse(new TextDecoder().decode(result.stdout));
  assertEquals(frame.ok, false);
  assertEquals(frame.error.message, "Unknown scenario profile");
  assertEquals(JSON.parse(await Deno.readTextFile(record)), {
    pids: [child.pid],
    ports: [],
  });
});

test("private sidecar HOME accepts binary fixtures but refuses escapes", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "tests/support/fixture-controller.ts"],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = child.stdin.getWriter();
  const lines = createInterface({ input: Readable.from(child.stdout) });
  const reader = lines[Symbol.asyncIterator]();
  const call = async (command: string, params: object) => {
    const id = crypto.randomUUID();
    await writer.write(new TextEncoder().encode(
      JSON.stringify({ v: 1, id, command, params }) + "\n",
    ));
    const line = await reader.next();
    assert(!line.done, `controller stopped during ${command}`);
    const frame = JSON.parse(line.value);
    assertEquals(frame.id, id);
    return frame;
  };
  try {
    const start = await call("start", {
      profile: "messages-private-home",
      version: nativeVersion,
    });
    assert(start.ok, start.error?.message);
    const begin = await call("beginTest", { identity: "home-fixtures" });
    assert(begin.ok, begin.error?.message);
    const { lease } = begin.result;
    const write = (name: string) =>
      call("writeHomeFiles", { lease, files: { [name]: "AP8=" } });
    const valid = await write("fixtures/pixels");
    assert(valid.ok, valid.error?.message);
    const { home } = valid.result;
    assert(home.startsWith(start.result.root + "/home-"));
    assertEquals(
      await Deno.readFile(join(home, "fixtures/pixels")),
      Uint8Array.of(0, 255),
    );
    const session = await call("nativeRequest", {
      lease,
      path: "/session",
      method: "POST",
      body: { title: "Private HOME" },
    });
    assert(session.ok, session.error?.message);
    const sessionID = browserSessionID(session.result.id);
    const stat = await call("productRpc", {
      lease,
      method: "file.stat",
      params: { sessionID, paths: ["~/fixtures/pixels"] },
    });
    assert(stat.ok, stat.error?.message);
    assertEquals(stat.result[0].resolved, join(home, "fixtures/pixels"));
    assertEquals(
      (await write("../x")).error?.message,
      "File outside fixture root",
    );
    await Deno.symlink(begin.result.directory, join(home, "linked"));
    assertEquals((await write("linked/x")).error?.message, "Symlink parent");
    assertEquals((await write("linked")).error?.message, "Symlink target");
    const end = await call("endTest", { lease });
    assert(end.ok, end.error?.message);
  } finally {
    await writer.close();
    await child.status;
    lines.close();
  }
});
