// SPDX-License-Identifier: LGPL-3.0-only
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { select } from "../../../scripts/tests/selection.ts";
const workspace = resolve("../..");
const root = join(
  workspace,
  ".test-state/runs",
  `acceptance-${process.argv[2]}-${crypto.randomUUID()}`,
);
mkdirSync(root, { recursive: true });
const child = (
  name: string,
  args: string[],
  env: Record<string, string> = {},
) => {
  const output = join(root, name);
  mkdirSync(output);
  const result = spawnSync("npm", ["run", ...args], {
    encoding: "utf8",
    env: { ...process.env, OTK_TEST_RUN_ROOT: output, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(
    join(output, "child.log"),
    (result.stdout ?? "") + (result.stderr ?? ""),
  );
  assert.ifError(result.error);
  return { output, status: result.status };
};
if (process.argv[2] === "reporting") {
  const run = child("flaky", ["reporting"], { OTK_TEST_MATRIX_FULL: "1" });
  assert.notEqual(run.status, 0, "flaky qualification must fail");
  const report = JSON.parse(
    readFileSync(join(run.output, "outcomes.json"), "utf8"),
  );
  assert.equal(report.counts.flaky, 1);
  const first = report.rows[0].attempts[0];
  assert.equal(first.retry, 0);
  assert.equal(first.status, "failed");
  for (const name of ["trace", "screenshot", "video"]) {
    const attachment = first.attachments.find((a: { name: string }) =>
      a.name === name
    );
    assert(
      attachment && existsSync(attachment.path),
      `missing first attempt ${name}`,
    );
  }
  const attachments = report.rows.find((row: { stableID: string }) =>
    row.stableID === "reporting.attachments-stay-file-backed"
  ).attempts[0].attachments;
  assert.equal(attachments.length, 128);
  for (const attachment of attachments) {
    assert.equal(attachment.body, undefined);
    assert.deepEqual(
      readFileSync(attachment.path),
      Buffer.alloc(256 * 1024, 255),
    );
  }
  const html = join(root, "html");
  const merged = spawnSync("npm", [
    "exec",
    "--",
    "playwright",
    "merge-reports",
    "--reporter=html",
    join(run.output, "blob"),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PLAYWRIGHT_HTML_OUTPUT_DIR: html,
      PLAYWRIGHT_HTML_OPEN: "never",
    },
  });
  writeFileSync(join(root, "merge.log"), merged.stdout + merged.stderr);
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert(existsSync(join(html, "index.html")));
  const q = spawnSync("deno", [
    "run",
    "-A",
    "scripts/tests/quarantine.ts",
    process.env.OTK_TEST_VERSION!,
  ], { cwd: workspace, encoding: "utf8" });
  assert.equal(q.status, 0, q.stderr);
  assert.match(q.stdout, /QUARANTINE LANE.*empty/);
  writeFileSync(join(root, "quarantine.log"), q.stdout);
  console.log(
    "FLAKE1: flaky distinct, first failure retained, binary attachments intact, HTML merged, visible empty quarantine lane",
  );
} else if (process.argv[2] === "selection") {
  const project = `--project=oc-${process.env.OTK_TEST_VERSION}`;
  let smoke: string[] | undefined;
  for (
    const [name, paths] of Object.entries({
      composer: ["packages/ui/features/prompt/editor.tsx"],
      css: ["packages/ui/theme.css"],
      sql: ["packages/store/schema.sql"],
      rename: ["old/unmapped.ts", "packages/ui/features/prompt/new.tsx"],
      deleted: ["deleted/unmapped.ts"],
      transport: ["core/transport.ts"],
      docs: ["docs/testing.md"],
      unknown: ["unknown.ts"],
    })
  ) {
    const selection = select(paths, [], "HEAD");
    const r = child(name, [
      "test",
      "--",
      project,
      "--list",
      "--grep",
      `@(${[...selection.areas, "smoke"].join("|")})(?:\\s|$)`,
    ]);
    assert.equal(
      r.status,
      0,
      readFileSync(join(r.output, "child.log"), "utf8"),
    );
    const report = JSON.parse(
      readFileSync(join(r.output, "outcomes.json"), "utf8"),
    );
    const rows = report.rows as { id: string; tags: string[] }[];
    assert(rows.length);
    assert(rows.every((r) => !r.tags.includes("@scale")));
    const currentSmoke = rows.filter((r) => r.tags.includes("@smoke")).map((
      r,
    ) => r.id).sort();
    if (smoke) assert.deepEqual(currentSmoke, smoke);
    else smoke = currentSmoke;
    assert(currentSmoke.length);
    for (const area of selection.areas) {
      assert(rows.some((r) => r.tags.includes(`@${area}`)));
    }
    writeFileSync(
      join(r.output, "selection.json"),
      JSON.stringify(selection, null, 2),
    );
  }
  assert.notEqual(
    child("empty", [
      "test",
      "--",
      project,
      "--list",
      "--grep",
      "@does-not-exist",
    ]).status,
    0,
  );
  console.log(
    "SEL1: controlled CSS/SQL/rename/delete/transport/docs/unknown collections, all smoke and visible empty failure",
  );
} else if (process.argv[2] === "sharding") {
  const project = `--project=oc-${process.env.OTK_TEST_VERSION}`;
  const collect = (name: string, extra: string[]) => {
    const r = child(name, [
      "test",
      "--",
      project,
      "--list",
      ...extra,
    ]);
    assert.equal(r.status, 0);
    const report = JSON.parse(
      readFileSync(join(r.output, "outcomes.json"), "utf8"),
    );
    return report.rows.map((r: { id: string }) => r.id).sort() as string[];
  };
  const all = collect("all", []),
    one = collect("one", ["--shard=1/2"]),
    two = collect("two", ["--shard=2/2"]);
  assert(one.length && two.length);
  assert(!one.some((id) => two.includes(id)));
  assert.deepEqual([...one, ...two].sort(), all);
  for (const shard of ["1/2", "2/2"]) {
    const r = spawnSync("deno", [
      "task",
      "test:e2e",
      project,
      "--grep",
      "@smoke",
      "--retries=0",
      `--shard=${shard}`,
    ], { cwd: workspace, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(
      join(root, `smoke-${shard.replace("/", "-")}.log`),
      r.stdout + r.stderr,
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  writeFileSync(
    join(root, "partition.json"),
    JSON.stringify({ all, one, two }, null, 2),
  );
  console.log(
    `SHARD1: ${one.length}+${two.length}=${all.length} disjoint union; both real smoke shards passed`,
  );
} else throw new Error("Select reporting, selection or sharding");
console.log("Acceptance evidence:", root);
