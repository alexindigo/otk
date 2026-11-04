// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { readBuild, sourceTree } from "./prepare.ts";

const group = Deno.args[0];
if (group !== "standard" && group !== "scale") {
  throw new Error("Select integration group: standard | scale");
}
const jobs = Deno.env.get("DENO_JOBS");
if (jobs !== (group === "standard" ? "3" : "1")) {
  throw new Error(`Unexpected DENO_JOBS=${jobs} for ${group}`);
}
const directory = group === "standard"
  ? "tests/integration"
  : "tests/integration/scale";
const files: string[] = [];
// Deliberately nonrecursive: standard discovery cannot admit scale fixtures.
for await (const entry of Deno.readDir(directory)) {
  if (entry.isFile && entry.name.endsWith("_test.ts")) {
    files.push(join(directory, entry.name));
  }
}
files.sort();
const areaAt = Deno.args.indexOf("--areas");
const selectedAreas = areaAt < 0
  ? undefined
  : Deno.args[areaAt + 1]?.split(",");
if (selectedAreas && !selectedAreas.includes("*")) {
  const matched = files.filter((file) => selectedAreas.includes(file));
  if (!matched.length) throw new Error("Empty selected integration collection");
  files.splice(0, files.length, ...matched);
}
if (!files.length) throw new Error(`Empty integration group: ${group}`);
const tree = await sourceTree();
const build = await readBuild(tree);
const guest = Deno.env.get("OTK_TEST_GUEST") ?? ({
  "1.18.34": "otk-tests-a",
  "1.18.35": "otk-tests-b",
  "1.19.3": "otk-tests-c",
} as Record<string, string>)[build.native.version];
const run =
  `integration-${guest}-${build.native.version}-${group}-${Date.now()}-${crypto.randomUUID()}`;
const root = join(Deno.cwd(), ".test-state/runs", run);
await Deno.mkdir(root, { recursive: true });
const args = [
  "test",
  "--parallel",
  "--allow-net",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys=systemMemoryInfo",
  ...Deno.args.slice(1).filter((_, i) =>
    areaAt < 0 || i + 1 !== areaAt && i + 1 !== areaAt + 1
  ),
  ...files,
];
const selection = {
  schema: 1,
  run,
  tree,
  guest,
  native: build.native,
  group,
  DENO_JOBS: jobs,
  files,
  args,
  binaries: {
    otk: build.binarySha256,
    digestConsumer: build.digestConsumer.sha256,
  },
};
await Deno.writeTextFile(
  join(root, "selection.json"),
  JSON.stringify(selection, null, 2),
);
console.info("Integration selection:", JSON.stringify(selection, null, 2));
const start = performance.now();
let exit = 1;
try {
  const status = await new Deno.Command(Deno.execPath(), {
    args,
    env: {
      DENO_JOBS: jobs,
      OTK_TEST_TREE: tree,
      OTK_TEST_PORTS_ROOT: join(root, "ports"),
      OTK_TEST_BINARY: build.binary,
      OTK_TEST_DIGEST_CONSUMER_BINARY: build.digestConsumer.path,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    signal: AbortSignal.timeout(24 * 60 * 60_000),
  }).spawn().status;
  exit = status.code;
} finally {
  const result = {
    ...selection,
    exit,
    seconds: (performance.now() - start) / 1000,
  };
  await Deno.writeTextFile(
    join(root, "run.json"),
    JSON.stringify(result, null, 2),
  );
  console.info("Integration run receipt:", join(root, "run.json"));
}
Deno.exit(exit);
