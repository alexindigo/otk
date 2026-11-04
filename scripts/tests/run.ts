// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { pathsFromNul, select } from "./selection.ts";
import { sourceTree } from "./source.ts";

const value = (name: string) => {
  const at = Deno.args.indexOf(name);
  return at < 0 ? undefined : Deno.args[at + 1];
};
const file = value("--changed-paths");
if (!file) {
  throw new Error("test:commit requires --changed-paths FILE (NUL-delimited)");
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
const tiers: [string, string[]][] = [
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
  ]]);
}
tiers.push(["collection", ["run", "-A", "scripts/tests/collect.ts", version]]);
tiers.push(["browser", [
  "task",
  "test:e2e",
  `--project=oc-${version}`,
  "--grep",
  `@(${[...selection.areas, "smoke"].join("|")})(?:\\s|$)`,
  "--retries=0",
  ...Deno.args.filter((a) => a.startsWith("--shard=")),
]]);
if (selection.themes && version === "1.18.34") {
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
const results = [];
const start = performance.now();
console.info("Selection:", JSON.stringify({ tree, ...selection, tiers }));
if (Deno.args.includes("--dry-run")) {
  await Deno.writeTextFile(
    join(root, "selection.json"),
    JSON.stringify(
      { tree, ...selection, tiers, qualification: false },
      null,
      2,
    ),
  );
  Deno.exit(0);
}
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
  await Deno.writeTextFile(
    join(root, "lane.json"),
    JSON.stringify(
      {
        schema: 1,
        tree,
        selection,
        results,
        complete: results.length === tiers.length,
        seconds: (performance.now() - start) / 1000,
        exit: results.some((r) => r.exit) ? 1 : 0,
      },
      null,
      2,
    ),
  );
  if (!child.success) Deno.exit(child.code);
}
