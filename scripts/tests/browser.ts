// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { readBuild, sourceTree } from "./prepare.ts";
import { nativeLane } from "./lanes.ts";

const tree = await sourceTree();
const scale = Deno.args.includes("--scale");
const themes = Deno.args.includes("--themes");
const args = Deno.args.filter((arg) => !["--scale", "--themes"].includes(arg));
const retry = args.find((arg) => arg.startsWith("--retries="))?.slice(10) ??
  (args.includes("--retries")
    ? args[args.indexOf("--retries") + 1]
    : undefined);
if (
  retry && retry !== "0" &&
  !(retry === "1" && Deno.env.get("OTK_TEST_MATRIX_FULL") === "1")
) {
  throw new Error("Automatic retries are full-matrix-only");
}
const receipt = await readBuild(tree);
const project =
  Deno.args.find((arg) => arg.startsWith("--project="))?.slice(10) ??
    Deno.args[Deno.args.indexOf("--project") + 1];
if (
  project !==
    (themes
      ? "themes"
      : `${scale ? "scale" : "oc"}-${receipt.native.version}`) ||
  (themes &&
    nativeLane(receipt.native.version, Deno.env.get("OTK_TEST_LANE")) !== "A")
) {
  throw new Error(
    "Explicit project must match this guest's prepared native version",
  );
}
const guest = Deno.env.get("OTK_TEST_GUEST") ??
  ({
    "1.18.34": "otk-tests-a",
    "1.18.35": "otk-tests-b",
    "1.19.3": "otk-tests-c",
    "2.2.6": `otk-tests-${
      nativeLane(receipt.native.version, Deno.env.get("OTK_TEST_LANE"))
        .toLowerCase()
    }`,
  } as Record<string, string>)[receipt.native.version];
const shard =
  (Deno.args.find((arg) => arg.startsWith("--shard="))?.slice(8) ?? "all")
    .replaceAll("/", "-");
const run = `otk-${guest}-${
  themes ? "themes" : scale ? "scale" : "oc"
}-${receipt.native.version}-${shard}-${
  new Date().toISOString().replace(/[^0-9]/g, "")
}-${crypto.randomUUID()}`;
const root = join(Deno.cwd(), ".test-state/runs", run);
await Deno.mkdir(root, { recursive: true });
const inventory = join(root, "units.jsonl");
const env = {
  OTK_TEST_TREE: tree,
  OTK_TEST_BINARY: receipt.binary,
  OTK_TEST_RUN: run,
  OTK_TEST_RUN_ROOT: root,
  OTK_TEST_UNIT_INVENTORY: inventory,
  OTK_TEST_DENO_VERSION: Deno.version.deno,
  // Nested acceptance invocations belong to the same allocator lifetime. A new
  // evidence/run root must not let them lease an in-flight parent's port again.
  OTK_TEST_PORTS_ROOT: Deno.env.get("OTK_TEST_PORTS_ROOT") ??
    join(root, "ports"),
  OTK_TEST_GUEST: guest,
  OTK_TEST_NATIVE_SHA256: receipt.native.sha256,
};
const start = performance.now();
let exit = 1;
const errors: unknown[] = [];
const cleanupProof: unknown[] = [];
try {
  const status = await new Deno.Command("npm", {
    args: [
      "--prefix",
      "tests/browser",
      "run",
      themes ? "themes" : scale ? "scale" : "test",
      "--",
      ...args,
    ],
    env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    signal: AbortSignal.timeout(24 * 60 * 60_000),
  }).spawn().status;
  exit = status.code;
} catch (error) {
  errors.push(error);
}
{
  try {
    const records = (await Deno.readTextFile(inventory)).trim().split("\n")
      .filter(Boolean);
    for (const line of records) {
      const { unit, root: ownedRoot } = JSON.parse(line);
      try {
        if (typeof unit !== "string" || !unit.startsWith(run + "-")) {
          throw new Error("Foreign unit inventory");
        }
        const result = await new Deno.Command("systemctl", {
          args: ["--user", "stop", unit],
          signal: AbortSignal.timeout(15_000),
        }).output();
        // Units collected after a clean exit are absent. Other failures are retained.
        if (
          !result.success &&
          !new TextDecoder().decode(result.stderr).includes("not loaded")
        ) {
          errors.push(new Error(new TextDecoder().decode(result.stderr)));
        }
        const state = await new Deno.Command("systemctl", {
          args: ["--user", "show", unit, "--property=ControlGroup", "--value"],
          signal: AbortSignal.timeout(5000),
        }).output();
        if (!state.success || new TextDecoder().decode(state.stdout).trim()) {
          throw new Error(`Controller cgroup not empty: ${unit}`);
        }
        let owned: { pids: number[]; ports: number[] } | undefined;
        if (
          typeof ownedRoot !== "string" || !ownedRoot.startsWith(root + "/")
        ) throw new Error("Foreign controller root");
        try {
          owned = JSON.parse(
            await Deno.readTextFile(join(ownedRoot, "owned.json")),
          );
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        for (const pid of owned?.pids ?? []) {
          // A stopped cgroup can precede orphan reaping after a worker crash.
          // Join PID disappearance, as the controller does, instead of racing it.
          const deadline = performance.now() + 5000;
          while (true) {
            const alive = await new Deno.Command("/usr/bin/kill", {
              args: ["-0", String(pid)],
              signal: AbortSignal.timeout(5000),
            }).output();
            if (!alive.success) break;
            if (performance.now() >= deadline) {
              throw new Error(`Owned PID survived cleanup: ${pid}`);
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
          }
        }
        for (const port of owned?.ports ?? []) {
          let connection: Deno.TcpConn;
          try {
            connection = await Deno.connect({ hostname: "127.0.0.1", port });
          } catch (error) {
            if (error instanceof Deno.errors.ConnectionRefused) continue;
            throw error;
          }
          connection.close();
          throw new Error(`Owned port survived cleanup: ${port}`);
        }
        cleanupProof.push({
          unit,
          ...owned,
          cgroupEmpty: true,
          processesGone: true,
          portsClosed: true,
        });
      } catch (error) {
        errors.push(error);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) errors.push(error);
  }
  await Deno.writeTextFile(
    join(root, "run.json"),
    JSON.stringify(
      {
        schema: 1,
        run,
        parentRun: Deno.env.get("OTK_TEST_RUN") ?? null,
        tree,
        native: receipt.native,
        binary: { path: receipt.binary, sha256: receipt.binarySha256 },
        command: Deno.args,
        exit,
        seconds: (performance.now() - start) / 1000,
        cleanupErrors: errors.map(String),
        cleanupProof,
      },
      null,
      2,
    ),
  );
  console.info("Browser run receipt:", join(root, "run.json"));
  if (errors.length) {
    throw new AggregateError(errors, "Run supervisor cleanup failed");
  }
}
Deno.exit(exit);
