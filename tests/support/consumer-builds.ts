// SPDX-License-Identifier: LGPL-3.0-only
import { dirname, join } from "@std/path";
import { exclusive, exists, fileHashes, stateRoot } from "./snapshots.ts";
import { sourceTree } from "../../scripts/tests/source.ts";

export const CONSUMERS = {
  "theme-scenes": "tests/support/theme-consumer/vite.config.ts",
  ui: "tests/reuse/ui-consumer/vite.config.ts",
  dialog: "tests/reuse/dialog-consumer/vite.config.ts",
  context: "tests/support/context-consumer/vite.config.ts",
  panel: "tests/support/panel-consumer/vite.config.ts",
  remaining: "tests/support/remaining-consumer/vite.config.ts",
  "message-heap": "tests/support/message-heap-consumer/vite.config.ts",
  "provider-ports": "tests/support/provider-ports-consumer/vite.config.ts",
  styles: "packages/ui/tests/style-consumer/vite.config.ts",
  "native-events": "packages/ui/tests/native-events-consumer/vite.config.ts",
} as const;
export type Consumer = keyof typeof CONSUMERS;
interface ConsumerReceipt {
  schema: 1;
  input: string;
  files: Record<string, string>;
}
async function validate(directory: string, input: string) {
  const receipt: ConsumerReceipt = JSON.parse(
    await Deno.readTextFile(join(directory, "consumer.json")),
  );
  if (
    receipt.schema !== 1 || receipt.input !== input ||
    JSON.stringify(receipt.files) !==
      JSON.stringify(await fileHashes(join(directory, "dist")))
  ) throw new Error(`Prepared consumer identity mismatch: ${directory}`);
}
/** Preparation owns builds. Cases only validate and serve immutable assets. */
export async function prepareConsumers(tree: string): Promise<void> {
  for (const name of Object.keys(CONSUMERS) as Consumer[]) {
    // The exact source/config/content tree includes shared consumer helpers and
    // transitive imports. No manually maintained dependency list can go stale.
    const input = tree, directory = join(stateRoot(), "builds", tree, name);
    await exclusive(directory, async () => {
      if (await exists(directory)) {
        await validate(directory, input);
        console.info("Consumer reused", { name, input });
        return;
      }
      const start = performance.now();
      const stage = await Deno.makeTempDir({
        dir: dirname(directory),
        prefix: `.${name}-`,
      });
      const dist = join(stage, "dist");
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "npm:vite@8.2.0",
          "build",
          "--config",
          CONSUMERS[name],
          "--outDir",
          dist,
          "--logLevel",
          "warn",
        ],
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(120_000),
      }).output();
      if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
      await Deno.writeTextFile(
        join(stage, "consumer.json"),
        JSON.stringify(
          {
            schema: 1,
            input,
            files: await fileHashes(dist),
          } satisfies ConsumerReceipt,
        ),
      );
      await validate(stage, input);
      await Deno.rename(stage, directory);
      console.info("Consumer built", {
        name,
        input,
        ms: performance.now() - start,
      });
    });
  }
}
let currentTree: Promise<string> | undefined;
export async function consumerAssets(name: Consumer): Promise<string> {
  const tree = await (currentTree ??= sourceTree());
  if (Deno.env.get("OTK_TEST_TREE") && Deno.env.get("OTK_TEST_TREE") !== tree) {
    throw new Error("Consumer source tree mismatch");
  }
  const directory = join(stateRoot(), "builds", tree, name);
  try {
    await validate(directory, tree);
  } catch (cause) {
    throw new Error(
      `Prepare independent consumers first: deno task test:prepare --version ${
        Deno.env.get("OTK_TEST_VERSION")
      }`,
      { cause },
    );
  }
  return join(directory, "dist");
}
