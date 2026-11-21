// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { spawn } from "node:child_process";
import { kill } from "node:process";
import {
  type DaemonOptions,
  PtyDaemon,
  readRegistration,
  spawnDaemon,
} from "../../core/terminals/daemon.ts";
import { embeddedPtyBinary } from "../../core/terminals/binary.ts";
import { terminalOwner } from "../../core/terminals/ownership.ts";
import { shellEnvironment } from "../../core/terminals/env.ts";
import {
  TerminalHost,
  TerminalUnavailable,
} from "../../core/terminals/host.ts";
import { resources, tempDir, test } from "../support/resources.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function options(systemd: boolean): Promise<DaemonOptions> {
  const root = await tempDir("pty-");
  return {
    binary: fromFileUrl(embeddedPtyBinary()),
    runtimeDir: join(root, "pty"),
    handoffFile: join(root, "handoff.json"),
    environment: Deno.env.toObject(),
    systemd,
    signal: new AbortController().signal,
  };
}
function exists(pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ESRCH") return false;
    throw e;
  }
}
async function missing(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return false;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return true;
    throw e;
  }
}
async function gone(file: string, pid: number, limit = 8000): Promise<void> {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (await missing(file) && !exists(pid)) return;
    await delay(25);
  }
  assert(await missing(file), "daemon registration was not removed");
  assert(!exists(pid), "daemon process still exists");
}
async function noUnits(): Promise<void> {
  const result = await new Deno.Command("systemctl", {
    args: [
      "--user",
      "list-units",
      "--all",
      "--plain",
      "--no-legend",
      "otk-pty-*",
    ],
    signal: AbortSignal.timeout(5000),
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 0);
  assertEquals(new TextDecoder().decode(result.stdout).trim(), "");
}

for (const systemd of [false, true]) {
  const mode = systemd ? "systemd" : "detached";
  test(`real daemon ${mode}: actual shell excludes manager-only and OTK service environment`, async () => {
    const manager = async (...args: string[]) => {
      const result = await new Deno.Command("systemctl", {
        args: ["--user", ...args],
        signal: AbortSignal.timeout(5000),
      }).output();
      assertEquals(result.code, 0);
    };
    await manager(
      "set-environment",
      "OTK_P9_MANAGER_ONLY=secret-manager-sentinel",
    );
    resources().defer(
      "unset manager-only sentinel",
      () => manager("unset-environment", "OTK_P9_MANAGER_ONLY"),
    );
    const o = await options(systemd);
    const environment = {
      ...o.environment,
      OTK_P9_PROCESS_ONLY: "secret-process-sentinel",
      INVOCATION_ID: "service-sentinel",
      JOURNAL_STREAM: "journal-sentinel",
      NOTIFY_SOCKET: "notify-sentinel",
    };
    const daemon = await PtyDaemon.start({ ...o, environment });
    resources().defer("stop environment daemon", () => daemon.shutdown());
    const created = await daemon.request({
      op: "create_pty",
      program: "/bin/sh",
      args: ["-c", "env; printf '\\nP9-ENV-END\\n'; sleep 30"],
      cwd: "/home/tester/otk",
      env: shellEnvironment(environment),
      group_id: "env-test",
      title: "env",
      cols: 200,
      rows: 80,
    });
    assert(created.type === "created");
    let text = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const snapshot = await daemon.request({
        op: "snapshot",
        id: created.process.id,
      });
      assert(snapshot.type === "snapshot");
      text = snapshot.text;
      if (text.includes("P9-ENV-END")) break;
      await delay(10);
    }
    assert(text.includes("P9-ENV-END"), text);
    assert(text.includes("OTK_TERMINAL=1"), text);
    assert(text.includes("TERM=xterm-256color"), text);
    assert(
      !/OTK_P9_|INVOCATION_ID=|JOURNAL_STREAM=|NOTIFY_SOCKET=|secret-/.test(
        text,
      ),
      text,
    );
  });
  test(`real daemon ${mode}: own, output, ticket reclaim, owner loss and unit cleanup`, async () => {
    const o = await options(systemd);
    const daemon = await PtyDaemon.start(o);
    resources().defer("stop first daemon", () => daemon.shutdown());
    assertEquals(daemon.registrationFile.split("/").at(-1), "service.json");
    const created = await daemon.request({
      op: "create_pty",
      program: "/bin/sh",
      args: ["-c", "printf hello; sleep 30"],
      cwd: "/home/tester/otk",
      env: { PATH: "/usr/bin:/bin" },
      group_id: "session-a",
      title: "hello",
      cols: 80,
      rows: 24,
    });
    assert(created.type === "created");
    const conn = await daemon.subscribe({
      op: "subscribe",
      id: created.process.id,
      offset: 0n,
      attachment_id: "test",
      role: "observer",
      takeover: false,
    });
    resources().defer("release first subscription", () => daemon.release(conn));
    const attached = await conn.response();
    assert(attached.type === "attached");
    let output = new TextDecoder().decode(decodeBase64(attached.replay_base64));
    while (!output.includes("hello")) {
      const event = await conn.next();
      assert(event !== null);
      if (event.kind === "output") {
        output += new TextDecoder().decode(event.bytes);
      }
    }
    assert(output.includes("hello"));
    await daemon.handoff();
    assertEquals((await Deno.stat(o.handoffFile)).mode! & 0o777, 0o600);
    assert(exists(daemon.pid));
    const next = await PtyDaemon.start(o);
    resources().defer("stop replacement daemon", () => next.shutdown());
    assertEquals(next.pid, daemon.pid);
    const list = await next.request({ op: "list", mode: "pty" });
    assert(list.type === "processes");
    assertEquals(list.processes[0].id, created.process.id);
    const snapshot = await next.request({
      op: "snapshot",
      id: created.process.id,
    });
    assert(snapshot.type === "snapshot");
    assert(snapshot.text.includes("hello"));
    assert(await missing(o.handoffFile));
    await next.disconnect();
    await gone(next.registrationFile, next.pid);
    if (systemd) await noUnits();
    console.info(
      JSON.stringify({
        mode,
        registration: "service.json",
        reclaimSamePID: true,
        ownerLossGone: true,
      }),
    );
  });
  test(`real daemon ${mode}: never owned exits after 5 s without manual cleanup`, async () => {
    const o = await options(systemd), name = `otk-pty-${crypto.randomUUID()}`;
    await Deno.mkdir(o.runtimeDir, { recursive: true, mode: 0o700 });
    const started = performance.now();
    await spawnDaemon(o, name);
    let registration;
    const end = Date.now() + 4000;
    while (!registration && Date.now() < end) {
      try {
        registration = await readRegistration(o.runtimeDir, name);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
        await delay(20);
      }
    }
    assert(registration);
    await gone(
      join(o.runtimeDir, name, "service.json"),
      registration.pid,
      7000,
    );
    const elapsed = performance.now() - started;
    assert(elapsed >= 4900 && elapsed < 7500, `never-owned exit ${elapsed} ms`);
    if (systemd) await noUnits();
    console.info(JSON.stringify({ mode, neverOwnedExitMs: elapsed }));
  });
  test(`real daemon ${mode}: unclaimed handoff leaves no process or unit after 125 s`, async () => {
    const o = await options(systemd), daemon = await PtyDaemon.start(o);
    resources().defer(
      "stop handoff daemon if still owned",
      () => daemon.shutdown(),
    );
    await daemon.handoff();
    const started = performance.now();
    await delay(125000);
    await gone(daemon.registrationFile, daemon.pid, 1000);
    if (systemd) await noUnits();
    // Expired descriptors must not prevent a fresh daemon start.
    const replacement = await PtyDaemon.start(o);
    resources().defer("stop fresh daemon", () => replacement.shutdown());
    assert(replacement.pid !== daemon.pid);
    await replacement.shutdown();
    await gone(replacement.registrationFile, replacement.pid);
    if (systemd) await noUnits();
    console.info(
      JSON.stringify({
        mode,
        unclaimedObservationMs: performance.now() - started,
        noProcess: true,
        noUnit: systemd,
      }),
    );
  });
}

test("failed handoff publication closes its owner without leaving a daemon", async () => {
  const o = await options(false), daemon = await PtyDaemon.start(o);
  resources().defer("stop publication-failure daemon", () => daemon.shutdown());
  await Deno.mkdir(o.handoffFile);
  await assertRejects(() => daemon.handoff());
  await gone(daemon.registrationFile, daemon.pid, 1000);
  assertEquals(daemon.alive, false);
});

test("real daemon: 200 single-byte input round trips and ordered coalescing", async () => {
  const daemon = await PtyDaemon.start(await options(false));
  resources().defer("stop timing daemon", () => daemon.shutdown());
  const created = await daemon.request({
    op: "create_pty",
    program: "/bin/sh",
    args: ["-c", "stty -echo -icanon; cat"],
    cwd: "/home/tester/otk",
    env: { PATH: "/usr/bin:/bin" },
    group_id: "timing",
    title: "cat",
    cols: 80,
    rows: 24,
  });
  assert(created.type === "created");
  const id = created.process.id;
  const conn = await daemon.subscribe({
    op: "subscribe",
    id,
    offset: 0n,
    attachment_id: "input",
    role: "observer",
    takeover: false,
  });
  resources().defer("release timing subscription", () => daemon.release(conn));
  assertEquals((await conn.response()).type, "attached");
  const input = (value: string) =>
    daemon.request({
      op: "input",
      id,
      attachment_id: "input",
      cols: 80,
      rows: 24,
      data_base64: encodeBase64(value),
    });
  const times: number[] = [];
  for (let i = 0; i < 200; i++) {
    const started = performance.now();
    await input("x");
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  console.info(
    JSON.stringify({
      inputRequests: 200,
      medianMs: times[99],
      p95Ms: times[189],
    }),
  );
  const pending = Array.from({ length: 100 }, () => input("y"));
  const resized = daemon.request({
    op: "resize",
    id,
    attachment_id: "input",
    cols: 91,
    rows: 33,
  });
  await Promise.all([...pending, resized]);
  const snapshot = await daemon.request({ op: "snapshot", id });
  assert(snapshot.type === "snapshot");
  assertEquals(snapshot.process.pty?.cols, 91);
  assertEquals(snapshot.process.pty?.rows, 33);
  await daemon.request({ op: "terminate", id });
});

test("terminal host is lazy, checkout scoped, restartable and reports unavailable", async () => {
  const root = await tempDir("pty-host-");
  const environment = {
    ...Deno.env.toObject(),
    OTK_PTY_BIN: fromFileUrl(embeddedPtyBinary()),
    SHELL: "/bin/sh",
    INVOCATION_ID: "",
  };
  const options = {
    statePath: join(root, "state"),
    dataDir: join(root, "data"),
    environment,
    signal: new AbortController().signal,
  };
  const host = await TerminalHost.start(options);
  resources().defer("stop terminal host", () => host.stop());
  assert(await missing(host.runtimeDir));
  assertEquals(await host.list("/home/tester/otk"), []);
  const created = await host.create(
    "tstv1-session-a",
    "/home/tester/otk",
    80,
    24,
  );
  assertEquals((await host.list("/home/tester/otk")).length, 1);
  assertEquals(await host.list("/home/tester/other"), []);
  await assertRejects(
    () => host.close("/home/tester/other", created.id),
    Error,
    "not found",
  );
  await host.stop();
  const next = await TerminalHost.start(options);
  resources().defer("stop replacement host", () => next.stop());
  assertEquals((await next.list("/home/tester/otk"))[0].id, created.id);
  assertEquals(
    terminalOwner((await next.list("/home/tester/otk"))[0].group_id),
    { dir: "/home/tester/otk", session: "tstv1-session-a" },
  );
  await next.close("/home/tester/otk", created.id);
  assertEquals(await next.list("/home/tester/otk"), []);
  const daemon = await next.daemon();
  let lost = 0;
  next.onGone(() => lost++);
  await daemon.shutdown();
  await gone(daemon.registrationFile, daemon.pid);
  assertEquals(lost, 1);
  const fresh = await next.create(
    "tstv1-session-b",
    "/home/tester/otk",
    80,
    24,
  );
  assertEquals(terminalOwner(fresh.group_id), {
    dir: "/home/tester/otk",
    session: "tstv1-session-b",
  });
  await (await next.daemon()).shutdown();
  const bad = await TerminalHost.start({
    ...options,
    statePath: join(root, "bad-state"),
    environment: {
      ...environment,
      OTK_PTY_BIN: "/does-not-exist/opencode-pty",
    },
  });
  resources().defer("stop unavailable host", () => bad.stop());
  const error = await assertRejects(() => bad.list("a"), TerminalUnavailable);
  assertEquals(error.code, "terminal-unavailable");
});

test("detached daemon has its own SID and survives a signal to its owner's process group", async () => {
  const o = await options(false), root = join(o.runtimeDir, "..");
  const module =
    new URL("../../core/terminals/daemon.ts", import.meta.url).href;
  const script = join(root, "owner.ts"),
    ready = join(root, "ready.json"),
    signalled = join(root, "signalled");
  await Deno.writeTextFile(
    script,
    `import {PtyDaemon} from ${JSON.stringify(module)};\nconst o=${
      JSON.stringify({ ...o, signal: undefined })
    };\nconst d=await PtyDaemon.start({...o,signal:new AbortController().signal});\nconst onSignal=()=>Deno.writeTextFileSync(${
      JSON.stringify(signalled)
    },"seen");\nDeno.addSignalListener("SIGUSR1",onSignal);\nawait Deno.writeTextFile(${
      JSON.stringify(ready)
    },JSON.stringify({pid:d.pid,file:d.registrationFile}));\nawait Deno.stdin.read(new Uint8Array(1));\nawait d.shutdown();\nDeno.removeSignalListener("SIGUSR1",onSignal);\n`,
  );
  const child = spawn(Deno.execPath(), ["run", "-A", toFileUrl(script).href], {
    detached: true,
    stdio: ["pipe", "ignore", "inherit"],
    env: Deno.env.toObject(),
  });
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  resources().defer("join signal probe", async () => {
    if (child.exitCode === null) child.stdin?.end("x");
    await completion;
  });
  const deadline = Date.now() + 10000;
  while (await missing(ready) && Date.now() < deadline) await delay(20);
  const info = JSON.parse(await Deno.readTextFile(ready)) as {
    pid: number;
    file: string;
  };
  const sid = async (pid: number) =>
    new TextDecoder().decode(
      (await new Deno.Command("ps", {
        args: ["-o", "sid=", "-p", String(pid)],
        signal: AbortSignal.timeout(5000),
      }).output()).stdout,
    ).trim();
  assert(child.pid);
  const ownerSID = await sid(child.pid), daemonSID = await sid(info.pid);
  assertEquals(daemonSID, String(info.pid));
  assert(ownerSID !== daemonSID);
  const result = await new Deno.Command("kill", {
    args: ["-USR1", "--", `-${child.pid}`],
    signal: AbortSignal.timeout(5000),
  }).output();
  assertEquals(result.code, 0);
  const until = Date.now() + 2000;
  while (await missing(signalled) && Date.now() < until) await delay(20);
  assert(!await missing(signalled));
  assert(exists(info.pid));
  assert(!await missing(info.file));
  console.info(
    JSON.stringify({
      spawn: "node:child_process detached",
      ownerSID,
      daemonSID,
      survivedGroupSignal: true,
    }),
  );
  child.stdin?.end("x");
  assertEquals(await completion, 0);
  await gone(info.file, info.pid);
});
