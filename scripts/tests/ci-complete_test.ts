// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  aggregate,
  jobs,
  type Plan,
  readReceipts,
  type Receipt,
  versions,
} from "./ci-complete.ts";
import { outcome } from "./report.ts";

function fixture(scale = true) {
  const plans: Plan[] = versions.map((version) => ({
    version,
    tiers: [
      ...new Set(
        jobs().filter((job) => job.version === version).flatMap((job) =>
          job.tiers
        ),
      ),
    ].filter((id) => scale || id !== "browser-scale").map((id) => ({ id })),
  }));
  const receipts: Receipt[] = jobs().map((job) => {
    const skipped = !scale && job.id.startsWith("browser-scale-");
    return {
      id: job.id,
      version: job.version,
      tree: "one-tree",
      exit: 0,
      skipped,
      lanes: skipped ? [] : [{
        version: job.version,
        tree: "one-tree",
        finished: true,
        exit: 0,
        selected: job.tiers,
        results: job.tiers.map((id) => ({
          id,
          exit: 0,
          command: [
            "deno",
            "task",
            id,
            ...(job.shard && ["browser", "browser-scale"].includes(id)
              ? [`--shard=${job.shard}`]
              : []),
          ],
        })),
      }],
      outcomes: skipped ? [] : [{
        rows: [{
          project: `oc-${job.version}`,
          stableID: job.id,
          ...outcome(["passed"]),
        }],
      }],
    };
  });
  return { plans, receipts };
}
for (const scale of [true, false]) {
  Deno.test(`CI complete receipts pass, browser-scale admitted=${scale}`, () => {
    const { plans, receipts } = fixture(scale);
    assertEquals(aggregate(plans, receipts).exit, 0);
    assertEquals(receipts.length, 19);
  });
}
Deno.test("CI missing tier fails by name", () => {
  const { plans, receipts } = fixture();
  receipts[0].lanes[0].results = receipts[0].lanes[0].results.filter((tier) =>
    tier.id !== "unit"
  );
  const result = aggregate(plans, receipts);
  assertEquals(result.exit, 1);
  assert(result.errors.includes("Missing successful tier: 1.19.3:unit"));
});
Deno.test("CI missing shard fails by name", () => {
  const { plans, receipts } = fixture();
  const result = aggregate(
    plans,
    receipts.filter((receipt) => receipt.id !== "browser-1.19.3-2of4"),
  );
  assertEquals(result.exit, 1);
  assert(
    result.errors.some((error) =>
      error.includes("Missing or duplicate shard: 1.19.3:browser")
    ),
  );
});
Deno.test("CI duplicate shard fails by name", () => {
  const { plans, receipts } = fixture();
  receipts.find((receipt) => receipt.id === "browser-2.2.6-2of4")!.lanes[0]
    .results.at(-1)!.command = ["deno", "--shard=1/4"];
  const result = aggregate(plans, receipts);
  assertEquals(result.exit, 1);
  assert(
    result.errors.some((error) =>
      error.includes("Missing or duplicate shard: 2.2.6:browser")
    ),
  );
});
Deno.test("CI mixed trees fail even within a job", () => {
  const { plans, receipts } = fixture();
  receipts[0].lanes[0].tree = "other";
  assert(
    aggregate(plans, receipts).errors.includes("Mixed trees: base-1.19.3"),
  );
  receipts[0].tree = "other";
  assert(aggregate(plans, receipts).errors.includes("Mixed or missing trees"));
});
Deno.test("CI failed tier stays failing when also failing on master", () => {
  const { plans, receipts } = fixture();
  receipts[0].lanes[0].results.find((tier) => tier.id === "unit")!.exit = 1;
  const result = aggregate(plans, receipts, ["tier-1.19.3:unit"]);
  assertEquals(result.exit, 1);
  assert(result.ids.includes("tier-1.19.3:unit"));
  assertStringIncludes(result.summary, "also failing on master");
});
Deno.test("CI flaky and not-run IDs fail; master labels never waive failures", () => {
  const { plans, receipts } = fixture();
  receipts[0].outcomes[0].rows = [{
    project: "oc-1.19.3",
    stableID: "flaky",
    ...outcome(["failed", "passed"]),
  }, { project: "oc-1.19.3", stableID: "absent", ...outcome([]) }];
  const result = aggregate(plans, receipts, ["oc-1.19.3:flaky"]);
  assertEquals(result.exit, 1);
  assertEquals(result.ids, ["oc-1.19.3:absent", "oc-1.19.3:flaky"]);
  assertStringIncludes(result.summary, "new in this PR");
  assertStringIncludes(result.summary, "also failing on master");
});
Deno.test("CI uses the reported verdict even with active quarantine metadata", () => {
  const { plans, receipts } = fixture();
  const report = receipts[0].outcomes[0];
  const row = (stableID: string, statuses: string[]) => ({
    project: "oc-1.19.3",
    stableID,
    ...outcome(statuses, true),
  });
  report.rows = [row("passing", ["passed"])];
  const passing = aggregate(plans, receipts);
  assertEquals(passing.ids, []);
  assertEquals(passing.exit, 0);
  report.rows.push(
    row("failed", ["failed"]),
    row("flaky", ["failed", "passed"]),
    row("not-run", []),
  );
  const failing = aggregate(plans, receipts);
  assertEquals(failing.ids, [
    "oc-1.19.3:failed",
    "oc-1.19.3:flaky",
    "oc-1.19.3:not-run",
  ]);
  assertEquals(failing.exit, 1);
});
Deno.test("CI missing plan, failed jobs, incomplete lanes and unexpected skips fail", () => {
  const { plans, receipts } = fixture();
  assertEquals(aggregate([], receipts).exit, 1);
  receipts[0].exit = 1;
  receipts[0].lanes[0].finished = false;
  receipts[1].skipped = true;
  const result = aggregate(plans, receipts);
  assert(result.errors.includes("Failed job: base-1.19.3"));
  assert(result.errors.includes("Incomplete lane: base-1.19.3"));
  assert(result.errors.includes("Unexpected skip: integration-1.19.3"));
  assertEquals(aggregate(plans, []).exit, 1);
});

Deno.test("CI reports the observed terminal-menu failure without a master waiver", () => {
  // Observed on source tree 9220316779da3efc32fa3fcd14cf15b9c22abeb4e91df67fe1f250d1f0e8f46c.
  const { plans, receipts } = fixture();
  const receipt = receipts.find((item) => item.id === "browser-1.19.3-1of4")!;
  const stableID = "menus.native-area-picker-approval-and-activity-consumers";
  const id = `oc-1.19.3:${stableID}`;
  receipt.outcomes = [{
    rows: [{ project: "oc-1.19.3", stableID, ...outcome(["failed"]) }],
  }];
  receipt.exit = receipt.lanes[0].exit = 1;
  receipt.lanes[0].results.find((tier) => tier.id === "browser")!.exit = 1;
  const fresh = aggregate(plans, receipts);
  const existing = aggregate(plans, receipts, [id]);
  assert(fresh.ids.includes(id));
  assertEquals(fresh.exit, 1);
  assertEquals(existing.exit, 1);
  assertStringIncludes(fresh.summary, `${id} | new in this PR`);
  assertStringIncludes(existing.summary, `${id} | also failing on master`);
  console.info(
    `Observed failure classification: ${id}; new in this PR -> also failing on master; verdict remains FAIL`,
  );
});
Deno.test("CI disk reader ignores collection inventories and child attempts", async () => {
  const root = await Deno.makeTempDir();
  try {
    const directory = root + "/receipts-base-1.19.3";
    await Deno.mkdir(directory + "/collection", { recursive: true });
    await Deno.mkdir(directory + "/attempt", { recursive: true });
    const { receipts } = fixture();
    await Deno.writeTextFile(
      directory + "/ci-job.json",
      JSON.stringify(receipts[0]),
    );
    await Deno.writeTextFile(
      directory + "/collection/outcomes.json",
      JSON.stringify({ rows: [{ category: "not-run" }] }),
    );
    await Deno.writeTextFile(
      directory + "/attempt/outcomes.json",
      JSON.stringify({ rows: [{ category: "flaky" }] }),
    );
    await Deno.writeTextFile(
      directory + "/attempt/run.json",
      JSON.stringify({ parentRun: "parent" }),
    );
    assertEquals((await readReceipts(root)).receipts[0].outcomes, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CI artifact layout reaches CLI verdict, JSON record and step summary", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { plans, receipts } = fixture();
    const input = root + "/receipts";
    for (const receipt of receipts) {
      const directory = input + "/receipts-" + receipt.id;
      await Deno.mkdir(directory + "/runs/full", { recursive: true });
      await Deno.mkdir(directory + "/runs/browser", { recursive: true });
      await Deno.writeTextFile(
        directory + "/ci-job.json",
        JSON.stringify(receipt),
      );
      await Deno.writeTextFile(
        directory + "/runs/full/lane.json",
        JSON.stringify(receipt.lanes[0]),
      );
      await Deno.writeTextFile(
        directory + "/runs/browser/run.json",
        JSON.stringify({ parentRun: null }),
      );
      await Deno.writeTextFile(
        directory + "/runs/browser/outcomes.json",
        JSON.stringify(receipt.outcomes[0]),
      );
      if (receipt.id.startsWith("base-")) {
        await Deno.writeTextFile(
          directory + "/full-plan-" + receipt.version + ".json",
          JSON.stringify(
            plans.find((plan) => plan.version === receipt.version),
          ),
        );
      }
    }
    const command = () =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          new URL("./ci-complete.ts", import.meta.url).pathname,
          "--receipts",
          input,
          "--output",
          root + "/failing-ids.json",
        ],
        env: { GITHUB_STEP_SUMMARY: root + "/summary.md" },
      }).output();
    assertEquals((await command()).code, 0);
    assertEquals(
      JSON.parse(await Deno.readTextFile(root + "/failing-ids.json")).ids,
      [],
    );
    assertStringIncludes(
      await Deno.readTextFile(root + "/summary.md"),
      "Verdict: PASS",
    );
    await Deno.remove(input + "/receipts-browser-1.19.3-2of4", {
      recursive: true,
    });
    assertEquals((await command()).code, 1);
    assertStringIncludes(
      await Deno.readTextFile(root + "/summary.md"),
      "Missing or duplicate shard: 1.19.3:browser",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
