// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { sourceTree } from "./source.ts";
import { stripVTControlCharacters } from "node:util";

const flags = new Set<string>();
for (let i = 0; i < Deno.args.length; i++) {
  const flag = Deno.args[i];
  if (
    !["--version", "--tiers", "--dry-run"].includes(flag) || flags.has(flag)
  ) {
    throw new Error(`Unknown or repeated argument: ${flag}`);
  }
  flags.add(flag);
  if (
    flag !== "--dry-run" && (!Deno.args[++i] || Deno.args[i].startsWith("--"))
  ) {
    throw new Error(`Missing value: ${flag}`);
  }
}
const value = (flag: string) => {
  const at = Deno.args.indexOf(flag);
  return at < 0 ? undefined : Deno.args[at + 1];
};
const version = value("--version");
if (!version || version !== Deno.env.get("OTK_TEST_VERSION")) {
  throw new Error("--version must match this guest's OTK_TEST_VERSION");
}
const tiers: [string, string[]][] = [
  ["prepare", ["task", "test:prepare", "--version", version, "--scale"]],
  ["fmt", ["fmt", "--check"]],
  ["lint", ["lint"]],
  ["check", ["task", "check"]],
  ["unit", ["task", "test:unit"]],
  ["arch", ["task", "test:arch"]],
  ["reuse", ["task", "test:reuse"]],
  ["integration", ["task", "test:integration"]],
  ["integration-scale", ["task", "test:integration:scale"]],
  ["browser", ["task", "test:e2e", `--project=oc-${version}`, "--retries=1"]],
  ["legacy", ["task", "test:e2e:legacy"]],
  ["migration", ["task", "test:migration", "--audit"]],
];
// T1's visual/scale browser assertions remain active in the legacy tier until
// their ledger transfers. Never run a second copy of that coverage.
const selected = value("--tiers")?.split(",");
if (selected?.some((name) => !tiers.some(([id]) => id === name))) {
  throw new Error("Unknown tier selection");
}
const lane = tiers.filter(([id]) => !selected || selected.includes(id));
if (Deno.args.includes("--dry-run")) {
  console.log(JSON.stringify(
    {
      version,
      complete: !selected,
      tiers: lane.map(([id, args]) => ({
        id,
        command: [Deno.execPath(), ...args],
      })),
      legacyIncludes: ["themes", "browser-scale"],
      compiledUpgrade: "integration",
    },
    null,
    2,
  ));
  Deno.exit(0);
}
const tree = await sourceTree();
const root = join(
  Deno.cwd(),
  ".test-state/runs",
  `full-${version}-${Date.now()}-${crypto.randomUUID()}`,
);
await Deno.mkdir(root, { recursive: true });
const started = new Date().toISOString(), start = performance.now();
const results: unknown[] = [];
let failed = false;
const environment = Object.entries(Deno.env.toObject()).filter(([key]) =>
  key.startsWith("OTK_TEST_") ||
  [
    "PATH",
    "HOME",
    "TMPDIR",
    "DENO_DIR",
    "DENO_JOBS",
    "PLAYWRIGHT_BROWSERS_PATH",
  ].includes(key)
).map(([key, value]) => `--setenv=${key}=${value}`);
async function finishTier(unit: string): Promise<void> {
  const stopped = await new Deno.Command("systemctl", {
    args: ["--user", "stop", unit],
    signal: AbortSignal.timeout(30_000),
  }).output();
  if (
    !stopped.success &&
    !new TextDecoder().decode(stopped.stderr).includes("not loaded")
  ) {
    throw new Error(new TextDecoder().decode(stopped.stderr));
  }
  const state = await new Deno.Command("systemctl", {
    args: ["--user", "show", unit, "--property=ControlGroup", "--value"],
    signal: AbortSignal.timeout(5000),
  }).output();
  if (new TextDecoder().decode(state.stdout).trim()) {
    throw new Error(`Tier cgroup survived: ${unit}`);
  }
}
for (const [id, args] of lane) {
  const before = performance.now(), at = new Date().toISOString();
  const output = await Deno.open(join(root, `${id}.log`), {
    write: true,
    createNew: true,
  });
  let exit = 1, error: string | undefined;
  const unit = `otk-full-${version}-${id}-${crypto.randomUUID()}.service`;
  // Persist ownership before acquisition, so an interrupted supervisor can find
  // the exact current tier even before its final result is available.
  await Deno.writeTextFile(
    join(root, "tiers.jsonl"),
    JSON.stringify({
      id,
      unit,
      command: [Deno.execPath(), ...args],
      started: at,
    }) + "\n",
    { append: true },
  );
  try {
    const child = new Deno.Command("systemd-run", {
      args: [
        "--user",
        "--wait",
        "--pipe",
        "--quiet",
        `--unit=${unit}`,
        "--property=KillMode=control-group",
        "--property=RuntimeMaxSec=24h",
        "--property=TimeoutStopSec=20s",
        `--working-directory=${Deno.cwd()}`,
        ...environment,
        `--setenv=OTK_TEST_TREE=${tree}`,
        Deno.execPath(),
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(24 * 60 * 60_000),
    }).spawn();
    const pump = async (
      stream: ReadableStream<Uint8Array>,
      terminal: Pick<Deno.FsFile, "write">,
    ) => {
      for await (const bytes of stream) {
        for (let at = 0; at < bytes.length;) {
          at += await output.write(bytes.subarray(at));
        }
        for (let at = 0; at < bytes.length;) {
          at += await terminal.write(bytes.subarray(at));
        }
      }
    };
    const [status] = await Promise.all([
      child.status,
      pump(child.stdout, Deno.stdout),
      pump(child.stderr, Deno.stderr),
    ]);
    exit = status.code;
  } catch (cause) {
    error = String(cause);
  } finally {
    try {
      await finishTier(unit);
    } catch (cause) {
      error = [error, String(cause)].filter(Boolean).join("; ");
      exit = 1;
    }
    output.close();
  }
  const text = stripVTControlCharacters(
    await Deno.readTextFile(join(root, `${id}.log`)),
  );
  const deno = [
    ...text.matchAll(
      /(?:ok|FAILED) \| (\d+) passed \| (\d+) failed(?: \| (\d+) ignored)?/g,
    ),
  ].at(-1);
  const count = (label: string) => {
    const matches = [
      ...text.matchAll(new RegExp(`(?:^|\\n)\\s*(\\d+) ${label}\\b`, "g")),
    ];
    return matches.length ? Number(matches.at(-1)![1]) : 0;
  };
  const counts = deno
    ? {
      passed: Number(deno[1]),
      failed: Number(deno[2]),
      ignored: Number(deno[3] ?? 0),
    }
    : id === "browser" && /(?:^|\n)\s*\d+ (?:passed|failed|flaky)\b/.test(text)
    ? {
      passed: count("passed"),
      failed: count("failed"),
      flaky: count("flaky"),
      skipped: count("skipped"),
    }
    : null;
  failed ||= exit !== 0;
  results.push({
    id,
    command: [Deno.execPath(), ...args],
    unit,
    started: at,
    finished: new Date().toISOString(),
    seconds: (performance.now() - before) / 1000,
    exit,
    counts,
    error,
    log: join(root, `${id}.log`),
  });
  await Deno.writeTextFile(
    join(root, "lane.json"),
    JSON.stringify(
      {
        schema: 1,
        version,
        tree,
        inventory: join(root, "tiers.jsonl"),
        started,
        complete: !selected,
        selected: lane.map(([id]) => id),
        results,
        finished: results.length === lane.length,
        seconds: (performance.now() - start) / 1000,
        exit: failed ? 1 : 0,
      },
      null,
      2,
    ),
  );
}
console.info("Full lane receipt:", join(root, "lane.json"));
Deno.exit(failed ? 1 : 0);
