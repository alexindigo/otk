// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { nativeVersion } from "./native.ts";

/** Raw observations, never performance assertions or an inferred passing receipt. */
export class RemainingMeasurements {
  readonly samples: { name: string; ms: number }[] = [];
  constructor(readonly root: string, readonly scenario: string) {}
  sync<T>(name: string, run: () => T): T {
    const start = performance.now();
    try {
      return run();
    } finally {
      this.samples.push({ name, ms: performance.now() - start });
    }
  }
  async time<T>(name: string, run: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await run();
    } finally {
      this.samples.push({ name, ms: performance.now() - start });
    }
  }
  async write(observations: Record<string, unknown>): Promise<void> {
    const value = {
      scenario: this.scenario,
      tree: Deno.env.get("OTK_TEST_TREE") ?? "unfrozen-working-tree",
      nativeVersion,
      denoVersion: Deno.version.deno,
      samples: this.samples,
      observations,
    };
    await Deno.writeTextFile(
      join(this.root, "remaining-measurements.json"),
      JSON.stringify(value, null, 2),
    );
    console.info("Remaining measurements", value);
  }
}

/** A complete, independently named 100 × 100 candidate universe. */
export async function remainingFiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  await Deno.writeTextFile(join(directory, ".gitignore"), ".opencode/\n");
  await Deno.mkdir(join(directory, "catalog"));
  for (let group = 0; group < 100; group++) {
    const parent = `catalog/group-${String(group).padStart(2, "0")}`;
    await Deno.mkdir(join(directory, parent));
    for (let n = 0; n < 100; n++) {
      const path = `${parent}/candidate-${
        String(group * 100 + n).padStart(5, "0")
      }.txt`;
      paths.push(path);
      await Deno.writeTextFile(
        join(directory, path),
        `Private candidate ${group * 100 + n} contents`,
      );
    }
  }
  return paths;
}
