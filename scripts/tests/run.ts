// SPDX-License-Identifier: LGPL-3.0-only
import { nativeLane } from "./lanes.ts";
import { join } from "@std/path";
import { browserGrep, pathsFromNul, select } from "./selection.ts";
import { sourceTree } from "./source.ts";

export const tierIds = [
  "fmt",
  "lint",
  "check",
  "unit",
  "arch",
  "no-product-hooks",
  "prepare",
  "integration",
  "collection",
  "browser",
  "themes",
  "integration-scale",
  "scale",
];

export function parseRunArgs(args: string[]) {
  const option = (name: string) => {
    const inline = args.find((arg) => arg.startsWith(name + "="));
    if (inline) return inline.slice(name.length + 1);
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const value = args[at + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    return value;
  };
  const count = option("--workers");
  if (
    count !== undefined &&
    (!/^\d+$/.test(count) || Number(count) < 1 ||
      !Number.isSafeInteger(Number(count)))
  ) {
    throw new Error("--workers must be a positive integer");
  }
  const tiers = option("--tiers")?.split(",");
  if (tiers?.some((id) => !tierIds.includes(id))) {
    throw new Error("Unknown commit tier");
  }
  return {
    workers: count === undefined ? undefined : Number(count),
    tiers,
    keepGoing: args.includes("--keep-going"),
  };
}

export function filterTiers(tiers: [string, string[]][], requested?: string[]) {
  return {
    tiers: requested ? tiers.filter(([id]) => requested.includes(id)) : tiers,
    skipped:
      requested?.filter((id) =>
        !tiers.some(([available]) => id === available)
      ) ?? [],
  };
}

export async function runCommit() {
  const options = parseRunArgs(Deno.args);
  const value = (name: string) => {
    const at = Deno.args.indexOf(name);
    return at < 0 ? undefined : Deno.args[at + 1];
  };
  const file = value("--changed-paths");
  if (!file) {
    throw new Error(
      "test:commit requires --changed-paths FILE (NUL-delimited)",
    );
  }
  const selection = select(
    pathsFromNul(await Deno.readFile(file)),
    value("--areas")?.split(",") ?? [],
    Deno.env.get("OTK_TEST_BASE") ?? "missing",
  );
  const version = Deno.env.get("OTK_TEST_VERSION");
  if (!version) throw new Error("Missing guest version");
  const tree = await sourceTree();
  const root = join(
    Deno.cwd(),
    ".test-state/runs",
    `commit-${version}-${crypto.randomUUID()}`,
  );
  await Deno.mkdir(root, { recursive: true });
  let tiers: [string, string[]][] = [
    ["fmt", ["fmt", "--check"]],
    ["lint", ["lint"]],
    ["check", ["task", "check"]],
    ["unit", ["task", "test:unit"]],
    ["arch", ["task", "test:arch"]],
    ["no-product-hooks", [
      "run",
      "--allow-read",
      "scripts/tests/product-hooks.ts",
    ]],
    ["prepare", [
      "task",
      "test:prepare",
      "--version",
      version,
      ...(selection.scale ? ["--scale"] : []),
    ]],
  ];
  if (selection.integration.length) {
    tiers.push(["integration", [
      "task",
      "test:integration",
      "--areas",
      selection.integration.join(","),
      `--junit-path=${join(root, "integration-junit.xml")}`,
    ]]);
  }
  tiers.push(["collection", [
    "run",
    "-A",
    "scripts/tests/collect.ts",
    version,
  ]]);
  tiers.push(["browser", [
    "task",
    "test:e2e",
    `--project=oc-${version}`,
    "--grep",
    browserGrep(selection),
    "--retries=0",
    ...(options.workers ? [`--workers=${options.workers}`] : []),
    ...Deno.args.filter((a) => a.startsWith("--shard=")),
  ]]);
  if (
    selection.themes &&
    nativeLane(version, Deno.env.get("OTK_TEST_LANE")) === "A"
  ) {
    tiers.push(["themes", ["task", "test:themes"]]);
  }
  if (selection.scale) {
    tiers.push(["integration-scale", ["task", "test:integration:scale"]]);
    tiers.push(["scale", [
      "task",
      "test:scale",
      `--project=scale-${version}`,
      "--retries=0",
    ]]);
  }
  const filtered = filterTiers(tiers, options.tiers);
  tiers = filtered.tiers;
  const results: { id: string; exit: number; seconds: number }[] = [];
  const start = performance.now();
  console.info("Selection:", JSON.stringify({ tree, ...selection, tiers }));
  await Deno.writeTextFile(
    join(root, "selection.json"),
    JSON.stringify(
      {
        tree,
        ...selection,
        tiers,
        skipped: filtered.skipped,
        qualification: !Deno.args.includes("--dry-run"),
      },
      null,
      2,
    ),
  );
  if (Deno.args.includes("--dry-run")) Deno.exit(0);
  const receipt = () =>
    Deno.writeTextFile(
      join(root, "lane.json"),
      JSON.stringify(
        {
          schema: 1,
          tree,
          selection,
          results,
          skipped: filtered.skipped,
          complete: results.length === tiers.length,
          seconds: (performance.now() - start) / 1000,
          exit: results.some((r) => r.exit) ? 1 : 0,
        },
        null,
        2,
      ),
    );
  await receipt();
  for (const [id, args] of tiers) {
    const at = performance.now();
    const child = await new Deno.Command(Deno.execPath(), {
      args,
      env: {
        OTK_TEST_TREE: tree,
        OTK_TEST_SELECTION: JSON.stringify(selection),
        OTK_TEST_MATRIX_FULL: "0",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    await Deno.writeFile(
      join(root, `${id}.log`),
      new Uint8Array([...child.stdout, ...child.stderr]),
    );
    console.log(new TextDecoder().decode(child.stdout));
    console.error(new TextDecoder().decode(child.stderr));
    results.push({
      id,
      exit: child.code,
      seconds: (performance.now() - at) / 1000,
    });
    await receipt();
    if (!child.success && !options.keepGoing) Deno.exit(child.code);
  }
  Deno.exit(results.some((r) => r.exit) ? 1 : 0);
}

if (import.meta.main) await runCommit();
