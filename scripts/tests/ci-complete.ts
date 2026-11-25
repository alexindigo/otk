// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";

export const versions = ["1.19.3", "2.2.6"] as const;
export type Plan = { version: string; tiers: { id: string }[] };
type Tier = { id: string; exit: number; command: string[] };
type Lane = {
  version: string;
  tree: string;
  finished: boolean;
  exit: number;
  selected: string[];
  results: Tier[];
};
export type Receipt = {
  id: string;
  version: string;
  tree: string;
  exit: number;
  skipped?: boolean;
  lanes: Lane[];
  outcomes: {
    rows: { project: string; stableID: string; exit: number }[];
  }[];
};
export type Job = {
  id: string;
  version: string;
  tiers: string[];
  shard?: string;
};
const base =
  "prepare,fmt,lint,check,unit,arch,no-product-hooks,reuse,collection,quarantine,migration";
export function jobs(): Job[] {
  return versions.flatMap((version) => [
    { id: `base-${version}`, version, tiers: base.split(",") },
    {
      id: `integration-${version}`,
      version,
      tiers: ["prepare", "integration"],
    },
    {
      id: `integration-scale-${version}`,
      version,
      tiers: ["prepare", "integration-scale"],
    },
    ...Array.from(
      { length: 4 },
      (_, i) => ({
        id: `browser-${version}-${i + 1}of4`,
        version,
        tiers: ["prepare", "collection", "browser"],
        shard: `${i + 1}/4`,
      }),
    ),
    ...Array.from(
      { length: 2 },
      (_, i) => ({
        id: `browser-scale-${version}-${i + 1}of2`,
        version,
        tiers: ["prepare", "browser-scale"],
        shard: `${i + 1}/2`,
      }),
    ),
    ...(version === "2.2.6"
      ? [{ id: "themes-2.2.6", version, tiers: ["prepare", "themes"] }]
      : []),
  ]);
}
const same = (a: string[], b: string[]) =>
  [...a].sort().join(",") === [...b].sort().join(",");
export function aggregate(
  plans: Plan[],
  receipts: Receipt[],
  master: string[] = [],
) {
  const errors: string[] = [],
    failing = new Set<string>(),
    trees = new Set<string>();
  const expected = jobs();
  for (const receipt of receipts) {
    if (!expected.some((job) => job.id === receipt.id)) {
      errors.push(`Unexpected job: ${receipt.id}`);
    }
    if (!receipt.tree) errors.push(`Missing tree: ${receipt.id}`);
    else trees.add(receipt.tree);
  }
  if (trees.size !== 1) errors.push("Mixed or missing trees");
  for (const version of versions) {
    const matching = plans.filter((plan) => plan.version === version);
    if (matching.length !== 1) {
      errors.push(
        `Expected one full plan for ${version}, found ${matching.length}`,
      );
      continue;
    }
    const tierIDs = matching[0].tiers.map((tier) => tier.id);
    if (!tierIDs.length || new Set(tierIDs).size !== tierIDs.length) {
      errors.push(`Invalid full plan: ${version}`);
    }
    const covered = new Set<string>(),
      shards: Record<string, string[]> = { browser: [], "browser-scale": [] };
    for (const job of expected.filter((job) => job.version === version)) {
      const found = receipts.filter((receipt) => receipt.id === job.id);
      if (found.length !== 1) {
        errors.push(
          `Missing or duplicate job: ${job.id} (found ${found.length})`,
        );
        continue;
      }
      const receipt = found[0];
      if (receipt.version !== version) errors.push(`Wrong version: ${job.id}`);
      if (receipt.exit !== 0) {
        errors.push(`Failed job: ${job.id}`);
        failing.add(`tier-${version}:job-${job.id}`);
      }
      const absent = job.id.startsWith("browser-scale-") &&
        !tierIDs.includes("browser-scale");
      if (absent) {
        if (!receipt.skipped || receipt.lanes.length) {
          errors.push(`Expected unadmitted browser-scale skip: ${job.id}`);
        }
        continue;
      }
      if (receipt.skipped) errors.push(`Unexpected skip: ${job.id}`);
      if (receipt.lanes.length !== 1) {
        errors.push(`Missing or duplicate lane: ${job.id}`);
        continue;
      }
      const lane = receipt.lanes[0];
      if (lane.tree !== receipt.tree) errors.push(`Mixed trees: ${job.id}`);
      if (lane.version !== version) {
        errors.push(`Wrong lane version: ${job.id}`);
      }
      if (!lane.finished) errors.push(`Incomplete lane: ${job.id}`);
      if (lane.exit !== 0) errors.push(`Failed lane: ${job.id}`);
      if (
        !same(lane.selected, job.tiers) ||
        !same(lane.results.map((result) => result.id), job.tiers)
      ) errors.push(`Missing or unexpected tiers: ${job.id}`);
      for (const tier of lane.results) {
        if (!tierIDs.includes(tier.id)) {
          errors.push(`Unexpected tier ${tier.id}: ${job.id}`);
        }
        if (tier.exit !== 0) {
          failing.add(`tier-${version}:${tier.id}`);
          errors.push(`Failed tier ${tier.id}: ${job.id}`);
        } else covered.add(tier.id);
        if (tier.id in shards) {
          const shard = tier.command.find((arg) => arg.startsWith("--shard="))
            ?.slice(8);
          if (!shard) errors.push(`Missing shard: ${job.id}:${tier.id}`);
          else {
            shards[tier.id].push(shard);
            if (shard !== job.shard) {
              errors.push(`Wrong shard: ${job.id} (${shard})`);
            }
          }
        }
      }
      if (
        job.tiers.some((id) =>
          ["browser", "browser-scale", "themes"].includes(id)
        ) && !receipt.outcomes.some((report) => report.rows.length)
      ) errors.push(`Missing browser outcomes: ${job.id}`);
      for (const report of receipt.outcomes) {
        for (const row of report.rows) {
          if (row.exit !== 0) {
            failing.add(`${row.project}:${row.stableID}`);
          }
        }
      }
    }
    for (const tier of tierIDs) {
      if (!covered.has(tier)) {
        errors.push(`Missing successful tier: ${version}:${tier}`);
      }
    }
    for (
      const [tier, count] of [["browser", 4], ["browser-scale", 2]] as const
    ) {
      if (!tierIDs.includes(tier)) continue;
      const wanted = Array.from(
        { length: count },
        (_, i) => `${i + 1}/${count}`,
      );
      if (!same(shards[tier], wanted)) {
        errors.push(
          `Missing or duplicate shard: ${version}:${tier} (${
            shards[tier].join(",")
          })`,
        );
      }
    }
  }
  const ids = [...failing].sort(), old = new Set(master);
  const escape = (text: string) => text.replace(/[|\r\n`]/g, " ");
  const summary = [
    "# Full-house PR checks",
    "",
    `Verdict: ${
      errors.length || ids.length ? "FAIL" : "PASS"
    }. ${receipts.length}/19 job receipts.`,
    "",
    "| # | Failing ID | Comparison |",
    "|---|---|---|",
    ...ids.map((id, i) =>
      `| ${i + 1} | ${escape(id)} | ${
        old.has(id) ? "also failing on master" : "new in this PR"
      } |`
    ),
    ...(ids.length ? [] : ["| 1 | None | - |"]),
    "",
    "| # | Coverage or job error |",
    "|---|---|",
    ...errors.map((error, i) => `| ${i + 1} | ${escape(error)} |`),
    ...(errors.length ? [] : ["| 1 | None |"]),
    "",
  ].join("\n");
  return { exit: errors.length || ids.length ? 1 : 0, ids, errors, summary };
}

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) result.push(...await files(path));
    else if (entry.isFile) result.push(path);
  }
  return result;
}
export async function readReceipts(
  root: string,
): Promise<{ plans: Plan[]; receipts: Receipt[] }> {
  const plans: Plan[] = [], receipts: Receipt[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    const paths = await files(join(root, entry.name));
    const json = async <T>(path: string): Promise<T> =>
      JSON.parse(await Deno.readTextFile(path));
    for (
      const path of paths.filter((path) =>
        /\/full-plan-[^/]+\.json$/.test(path)
      )
    ) plans.push(await json<Plan>(path));
    const envelopes = paths.filter((path) => path.endsWith("/ci-job.json"));
    if (envelopes.length !== 1) {
      throw new Error(`Expected one job receipt in ${entry.name}`);
    }
    const receipt = await json<Omit<Receipt, "lanes" | "outcomes">>(
      envelopes[0],
    );
    const lanes = await Promise.all(
      paths.filter((path) => path.endsWith("/lane.json")).map((path) =>
        json<Lane>(path)
      ),
    );
    const outcomes: Receipt["outcomes"] = [];
    for (
      const path of paths.filter((path) => path.endsWith("/outcomes.json"))
    ) {
      const runPath = path.slice(0, -"outcomes.json".length) + "run.json";
      if (!paths.includes(runPath)) continue; // --list inventories are not test results.
      if (
        (await json<{ parentRun: string | null }>(runPath)).parentRun !== null
      ) continue;
      outcomes.push(await json<Receipt["outcomes"][number]>(path));
    }
    receipts.push({ ...receipt, lanes, outcomes });
  }
  return { plans, receipts };
}
if (import.meta.main) {
  const args = Deno.args;
  if (
    args.length % 2 ||
    args.some((arg, i) =>
      i % 2 === 0 && !["--receipts", "--master", "--output"].includes(arg)
    )
  ) {
    throw new Error(
      "Usage: ci-complete.ts --receipts DIR [--master JSON] [--output JSON]",
    );
  }
  const flags = new Map(
    Array.from(
      { length: args.length / 2 },
      (_, i) => [args[i * 2], args[i * 2 + 1]],
    ),
  );
  const root = flags.get("--receipts");
  if (!root) throw new Error("Missing --receipts");
  const { plans, receipts } = await readReceipts(root);
  const master = flags.has("--master")
    ? JSON.parse(await Deno.readTextFile(flags.get("--master")!))
      .ids as string[]
    : [];
  const result = aggregate(plans, receipts, master);
  await Deno.writeTextFile(
    flags.get("--output") ?? "failing-ids.json",
    JSON.stringify(
      { schema: 1, ids: result.ids, errors: result.errors },
      null,
      2,
    ) + "\n",
  );
  console.info(result.summary);
  if (Deno.env.get("GITHUB_STEP_SUMMARY")) {
    await Deno.writeTextFile(
      Deno.env.get("GITHUB_STEP_SUMMARY")!,
      result.summary,
      { append: true },
    );
  }
  Deno.exit(result.exit);
}
