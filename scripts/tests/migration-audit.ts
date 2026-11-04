// SPDX-License-Identifier: LGPL-3.0-only
import { collectLegacy } from "./legacy-collection.ts";
import { hash as sha256 } from "./source.ts";
import { parse } from "@babel/parser";
import { oldBrowserConsumers } from "../../tests/arch/browser-retirement.ts";

interface Owner {
  runner: "legacy" | "playwright";
  file: string;
  testID: string;
}
interface Group {
  id: string;
  originalTitle: string;
  proofBoundary: string;
  destinations: Owner[];
  retainedCoverage: { themes: string[]; states: string[] };
  lowerTierWitness: { file: string; testID: string } | null;
  activeOwner: Owner;
  verificationReceipt: { kind: string; sourceSha256: string; run: string };
}
export interface MigrationFile {
  file: string;
  area: string;
  batch: string;
  proofBoundary: string;
  groups: Group[];
}
export async function migrationLedger(): Promise<MigrationFile[]> {
  const ledger = JSON.parse(
    await Deno.readTextFile("tests/browser/migration.json"),
  );
  if (
    ledger.schema !== 1 || ledger.originalFileCount !== 131 ||
    ledger.files.length !== 131
  ) {
    throw new Error("Migration inventory must retain all 131 original files");
  }
  return ledger.files;
}
export async function legacyFiles(): Promise<string[]> {
  return (await migrationLedger()).filter((row) =>
    row.groups.some((group) => group.activeOwner.runner === "legacy")
  ).map((row) => row.file).sort();
}
const areas = new Set([
  "harness",
  "transport",
  "messages",
  "composer",
  "sessions",
  "revert",
  "attention",
  "menus",
  "visual",
  "scale",
]);
function rejectDependencies(source: string, file: string): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === "CallExpression") {
      const callee = node.callee as {
        type?: string;
        property?: { name?: string };
      };
      if (
        callee?.type === "MemberExpression" &&
        ["skip", "only", "fixme"].includes(callee.property?.name ?? "")
      ) {
        throw new Error(`Skipped/exclusive proof: ${file}`);
      }
      if (
        callee?.type === "MemberExpression" &&
        callee.property?.name === "configure"
      ) {
        const args = node.arguments as {
          properties?: {
            key?: { name?: string };
            value?: { value?: unknown };
          }[];
        }[];
        if (
          args[0]?.properties?.some((p) =>
            p.key?.name === "mode" && p.value?.value === "serial"
          )
        ) throw new Error(`Serial product dependency: ${file}`);
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(parse(source, { sourceType: "module", plugins: ["typescript"] }));
}
interface Spec {
  id: string;
  file: string;
  title: string;
  tags: string[];
  tests: { expectedStatus: string; annotations: { type: string }[] }[];
}
interface Suite {
  specs?: Spec[];
  suites?: Suite[];
}
if (import.meta.main) {
  const allowed = [
    "--audit",
    "--require-no-legacy",
    "--require-no-old-driver-consumers",
  ];
  if (
    !Deno.args.includes("--audit") ||
    Deno.args.some((arg) => !allowed.includes(arg)) ||
    new Set(Deno.args).size !== Deno.args.length
  ) {
    throw new Error(`Usage: test:migration ${allowed.join(" ")}`);
  }
  const rows = await migrationLedger(),
    ids = new Set<string>(),
    files = new Set<string>();
  const active = await legacyFiles();
  const actual = Array.from(Deno.readDirSync("tests/e2e")).filter((e) =>
    e.isFile && e.name.endsWith("_test.ts")
  ).map((e) => `tests/e2e/${e.name}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(active)) {
    throw new Error("Legacy on-disk collection and ledger owners differ");
  }
  const cases = await collectLegacy(active);
  if (
    Deno.args.includes("--require-no-legacy") && (active.length || cases.length)
  ) {
    throw new Error("Legacy browser assertions remain");
  }
  const oldDriverConsumers = await oldBrowserConsumers();
  if (
    Deno.args.includes("--require-no-old-driver-consumers") &&
    oldDriverConsumers.length
  ) {
    throw new Error(
      `Retired browser consumers: ${oldDriverConsumers.join("; ")}`,
    );
  }
  for (const row of rows) {
    if (active.includes(row.file)) {
      rejectDependencies(await Deno.readTextFile(row.file), row.file);
    }
    if (
      files.has(row.file) || !areas.has(row.area) || !row.proofBoundary ||
      !row.groups.length
    ) throw new Error(`Invalid source row: ${row.file}`);
    files.add(row.file);
    const expected = cases.filter((item) => item.file === row.file).map(
      (item) => item.title,
    ).sort();
    const owned = row.groups.filter((group) =>
      group.activeOwner.runner === "legacy"
    ).map((group) => group.originalTitle).sort();
    if (JSON.stringify(expected) !== JSON.stringify(owned)) {
      throw new Error(`Unowned/double-owned assertion group: ${row.file}`);
    }
    const hash = active.includes(row.file) ? await sha256(row.file) : undefined;
    for (const group of row.groups) {
      if (
        ids.has(group.id) || !group.id || !group.originalTitle ||
        !group.proofBoundary
      ) throw new Error(`Duplicate/missing stable ID: ${group.id}`);
      ids.add(group.id);
      if (
        !group.destinations.length || !group.retainedCoverage.themes.length ||
        !group.retainedCoverage.states.length || !group.verificationReceipt.run
      ) throw new Error(`Incomplete proof: ${group.id}`);
      if (
        group.destinations.filter((owner) =>
          JSON.stringify(owner) === JSON.stringify(group.activeOwner)
        ).length !== 1
      ) {
        throw new Error(
          `Proof needs exactly one active destination: ${group.id}`,
        );
      }
      if (
        group.activeOwner.runner === "legacy" &&
        (group.activeOwner.file !== row.file ||
          group.activeOwner.testID !== group.id ||
          group.verificationReceipt.sourceSha256 !== hash)
      ) throw new Error(`Legacy collection receipt is stale: ${group.id}`);
      if (
        group.activeOwner.runner === "playwright" &&
        (group.verificationReceipt.kind !== "old-new-batch" ||
          !/^[a-f0-9]{64}$/.test(group.verificationReceipt.sourceSha256))
      ) {
        throw new Error(`Missing old/new transfer receipt: ${group.id}`);
      }
    }
  }
  const specs: Spec[] = [];
  const visit = (suite: Suite) => {
    specs.push(...suite.specs ?? []);
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const lane of ["", "scale", "themes"]) {
    const collection = await new Deno.Command("node", {
      args: [
        "tests/browser/node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        `tests/browser/playwright${lane ? "." + lane : ""}.config.ts`,
        "--list",
        "--reporter=json",
        `--project=${
          lane === "themes"
            ? "themes"
            : `${lane || "oc"}-${Deno.env.get("OTK_TEST_VERSION")}`
        }`,
      ],
      signal: AbortSignal.timeout(60_000),
      stdout: "piped",
      stderr: "inherit",
    }).output();
    if (!collection.success) throw new Error("Playwright collection failed");
    const report = JSON.parse(new TextDecoder().decode(collection.stdout));
    if (report.errors.length) throw new Error("Playwright collection errors");
    for (const suite of report.suites) visit(suite);
  }
  for (const row of rows) {
    for (const group of row.groups) {
      for (
        const owner of group.destinations.filter((owner) =>
          owner.runner === "playwright"
        )
      ) {
        const matches = specs.filter((spec) =>
          `tests/browser/${spec.file}` === owner.file &&
          spec.title === owner.testID
        );
        if (
          matches.length !== 1 ||
          !matches[0].tags.some((tag) => tag.replace(/^@/, "") === row.area)
        ) {
          throw new Error(
            `Missing/ambiguous destination or area: ${group.id}: ${owner.testID}`,
          );
        }
      }
      if (group.lowerTierWitness) {
        await Deno.stat(group.lowerTierWitness.file);
      }
    }
  }
  const supplemental = JSON.parse(
    await Deno.readTextFile("tests/browser/migration.json"),
  ).supplementalTransfers as {
    file: string;
    originalTitle: string;
    area: string;
    activeOwner: string;
    destination: Owner;
    verificationReceipt: Group["verificationReceipt"];
  }[];
  for (const transfer of supplemental) {
    const matches = specs.filter((spec) =>
      `tests/browser/${spec.file}` === transfer.destination.file &&
      spec.title === transfer.destination.testID
    );
    if (
      !transfer.originalTitle || transfer.activeOwner !== "playwright" ||
      transfer.destination.runner !== "playwright" || matches.length !== 1 ||
      !matches[0].tags.some((tag) => tag.replace(/^@/, "") === transfer.area) ||
      transfer.verificationReceipt.kind !== "old-new-batch" ||
      !/^[a-f0-9]{64}$/.test(transfer.verificationReceipt.sourceSha256) ||
      !transfer.verificationReceipt.run
    ) {
      throw new Error(
        `Invalid supplemental transfer: ${transfer.file}: ${transfer.originalTitle}`,
      );
    }
  }
  const browserIDs = new Set<string>(), counts: Record<string, number> = {};
  for (const spec of specs) {
    rejectDependencies(
      await Deno.readTextFile(`tests/browser/${spec.file}`),
      spec.file,
    );
    if (browserIDs.has(spec.id)) {
      throw new Error(`Duplicate Playwright ID: ${spec.id}`);
    }
    browserIDs.add(spec.id);
    const tags = spec.tags.filter((tag) => areas.has(tag.replace(/^@/, "")));
    if (!tags.length) {
      throw new Error(`Missing area: ${spec.file}: ${spec.title}`);
    }
    if (
      spec.tests.some((test) =>
        test.expectedStatus !== "passed" ||
        test.annotations.some((a) => ["skip", "fixme"].includes(a.type))
      )
    ) throw new Error(`Skipped proof: ${spec.title}`);
    for (const tag of tags) counts[tag] = (counts[tag] ?? 0) + 1;
  }
  if (!specs.length) throw new Error("Empty Playwright collection");
  console.log(JSON.stringify(
    {
      schema: 1,
      files: files.size,
      assertionGroups: ids.size,
      activeLegacyFiles: active.length,
      activeLegacyGroups: cases.length,
      oldDriverConsumers,
      supplementalTransfers: supplemental.length,
      playwright: specs.length,
      areas: counts,
      collectedLegacy: rows.filter((row) => active.includes(row.file)).map((
        row,
      ) => ({
        file: row.file,
        area: row.area,
        groups: row.groups.filter((group) =>
          group.activeOwner.runner === "legacy"
        ).map((group) => ({
          id: group.id,
          title: group.originalTitle,
        })),
      })),
      transferred: rows.flatMap((row) =>
        row.groups.filter((group) => group.activeOwner.runner === "playwright")
          .map((group) => ({
            source: row.file,
            area: row.area,
            id: group.id,
            owner: group.activeOwner,
            witness: group.lowerTierWitness,
            receipt: group.verificationReceipt,
          }))
      ),
      collectedPlaywright: specs.map(({ id, file, title, tags }) => ({
        id,
        file,
        title,
        tags,
      })),
      unowned: 0,
      doubleOwned: 0,
    },
    null,
    2,
  ));
}
