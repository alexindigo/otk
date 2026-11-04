// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { migrationLedger } from "./migration-audit.ts";
import { sourceTree } from "./source.ts";
import { collectLegacy } from "./legacy-collection.ts";
import { stripVTControlCharacters } from "node:util";

const area = Deno.args[Deno.args.indexOf("--area") + 1];
const version = Deno.args[Deno.args.indexOf("--version") + 1];
if (!area || version !== Deno.env.get("OTK_TEST_VERSION")) {
  throw new Error("Usage: test:batch --area AREA --version MATCHED_VERSION");
}
const rows = (await migrationLedger()).filter((row) =>
  area === "all" || row.area === area
);
if (!rows.length) throw new Error("Empty batch");
const groups = rows.flatMap((row) => row.groups);
const destinations = groups.flatMap((group) =>
  group.destinations.filter((owner) => owner.runner === "playwright")
);
if (
  groups.some((group) =>
    !group.destinations.some((owner) => owner.runner === "playwright") &&
    !group.lowerTierWitness && group.activeOwner.runner !== "legacy"
  )
) throw new Error("Batch has unmapped assertion groups");
if (!destinations.length && !groups.some((group) => group.lowerTierWitness)) {
  throw new Error("Batch needs a new destination or named witness to compare");
}
const tree = await sourceTree();
const root = join(
  Deno.cwd(),
  ".test-state/runs",
  `batch-${area}-${crypto.randomUUID()}`,
);
await Deno.mkdir(root, { recursive: true });
const results: {
  name: string;
  args: string[];
  exit: number;
  seconds: number;
  log: string;
  proof?: unknown;
}[] = [];
const run = async (
  name: string,
  args: string[],
  expected: { file: string; testID: string }[],
) => {
  const start = performance.now();
  const output = await new Deno.Command(Deno.execPath(), {
    args,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(24 * 60 * 60_000),
  }).output();
  const log = join(root, `${name}.log`);
  await Deno.writeFile(
    log,
    new Uint8Array([...output.stdout, ...output.stderr]),
  );
  console.log(new TextDecoder().decode(output.stdout));
  console.error(new TextDecoder().decode(output.stderr));
  const text = stripVTControlCharacters(
    new TextDecoder().decode(output.stdout),
  );
  let proof: unknown;
  if (output.success && name.startsWith("new")) {
    const receiptPath = text.match(/Browser run receipt: (.+)/)?.[1];
    if (!receiptPath) throw new Error("Missing browser outcome receipt");
    const report = JSON.parse(
      await Deno.readTextFile(join(receiptPath, "../results.json")),
    );
    const observed: { file: string; testID: string }[] = [];
    const visit = (
      suite: {
        specs?: {
          file: string;
          title: string;
          tests: { status: string; results: { status: string }[] }[];
        }[];
        suites?: unknown[];
      },
    ) => {
      for (const spec of suite.specs ?? []) {
        if (
          spec.tests.length !== 1 || spec.tests[0].status !== "expected" ||
          spec.tests[0].results.length !== 1 ||
          spec.tests[0].results[0].status !== "passed"
        ) throw new Error(`Non-first-pass outcome: ${spec.title}`);
        observed.push({
          file: `tests/browser/${spec.file}`,
          testID: spec.title,
        });
      }
      for (const child of suite.suites ?? []) {
        visit(child as Parameters<typeof visit>[0]);
      }
    };
    for (const suite of report.suites) visit(suite);
    const canonical = (items: typeof observed) =>
      JSON.stringify(items.map((item) => `${item.file}:${item.testID}`).sort());
    if (canonical(observed) !== canonical(expected)) {
      throw new Error("Batch destination/outcome mismatch");
    }
    proof = { receiptPath, observed, stats: report.stats };
  } else if (output.success) {
    const counts = text.match(/ok \| (\d+) passed \| (\d+) failed/);
    if (
      !counts || Number(counts[1]) !== expected.length ||
      Number(counts[2]) !== 0
    ) throw new Error("Deno witness/legacy population mismatch");
    proof = { passed: Number(counts[1]), failed: Number(counts[2]), expected };
  }
  results.push({
    name,
    args,
    exit: output.code,
    seconds: (performance.now() - start) / 1000,
    log,
    proof,
  });
  await Deno.writeTextFile(
    join(root, "batch.json"),
    JSON.stringify(
      {
        tree,
        version,
        area,
        groups: groups.map((group) => ({
          id: group.id,
          title: group.originalTitle,
          destinations: group.destinations,
          witness: group.lowerTierWitness,
          previousReceipt: group.verificationReceipt,
        })),
        results,
      },
      null,
      2,
    ),
  );
  if (!output.success) {
    throw new Error(`Batch ${name} failed: ${output.code}; ${log}`);
  }
};
const legacy = rows.filter((row) =>
  row.groups.some((group) => group.activeOwner.runner === "legacy")
).map((row) => row.file);
if (legacy.length) {
  const collected = await collectLegacy(legacy);
  const expected = rows.filter((row) => legacy.includes(row.file)).flatMap(
    (row) =>
      row.groups.filter((group) => group.activeOwner.runner === "legacy").map(
        (group) => `${row.file}:${group.originalTitle}`,
      ),
  ).sort();
  if (
    JSON.stringify(
      collected.map((item) => `${item.file}:${item.title}`).sort(),
    ) !== JSON.stringify(expected)
  ) throw new Error("Old assertion ledger/collection mismatch");
  await run(
    "old",
    ["task", "test:e2e:legacy", ...legacy],
    collected.map((item) => ({ file: item.file, testID: item.title })),
  );
} else {
  // Retirement is admitted only by an explicit prior old/new receipt, never by absence.
  if (
    groups.some((group) =>
      group.verificationReceipt.kind !== "old-new-batch" ||
      !group.verificationReceipt.run
    )
  ) throw new Error("Missing old/new retirement receipt");
}
for (const lane of ["behavior", "scale", "themes"]) {
  if (lane === "themes" && version !== "1.18.34") continue;
  const belongs = (file: string) =>
    (file.includes("/themes/")
      ? "themes"
      : file.includes("/scale/")
      ? "scale"
      : "behavior") === lane;
  const selected = [
    ...new Set(
      destinations.filter((owner) => belongs(owner.file))
        .map((owner) => owner.testID),
    ),
  ];
  if (selected.length) {
    await run(lane === "behavior" ? "new" : `new-${lane}`, [
      "task",
      lane === "themes"
        ? "test:themes"
        : lane === "scale"
        ? "test:scale"
        : "test:e2e",
      ...(lane === "themes"
        ? []
        : [`--project=${lane === "scale" ? "scale" : "oc"}-${version}`]),
      "--grep",
      selected.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "--retries=0",
      ...(lane === "scale" ? ["--workers=1"] : []),
    ], [
      ...new Map(
        destinations.filter((owner) => belongs(owner.file))
          .map(
            (owner) => [`${owner.file}:${owner.testID}`, {
              file: owner.file,
              testID: owner.testID,
            }],
          ),
      ).values(),
    ]);
  }
}
for (
  const witness of new Map(
    groups.flatMap((group) =>
      group.lowerTierWitness
        ? [
          [
            `${group.lowerTierWitness.file}:${group.lowerTierWitness.testID}`,
            group.lowerTierWitness,
          ] as const,
        ]
        : []
    ),
  ).values()
) {
  await run(`witness-${results.length}`, [
    "task",
    "test",
    "--filter",
    witness.testID,
    witness.file,
  ], [witness]);
}
console.log("Batch receipt:", join(root, "batch.json"));
