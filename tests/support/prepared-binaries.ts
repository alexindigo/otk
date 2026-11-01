// SPDX-License-Identifier: LGPL-3.0-only
import { readBuild, sourceTree } from "../../scripts/tests/prepare.ts";

/** Compile consumers only admit a binary qualified for the current exact tree. */
export async function preparedBinary(
  kind: "otk" | "digest-consumer" = "otk",
): Promise<string> {
  const tree = await sourceTree();
  const receipt = await readBuild(tree);
  const key = kind === "otk"
    ? "OTK_TEST_BINARY"
    : "OTK_TEST_DIGEST_CONSUMER_BINARY";
  const path = Deno.env.get(key);
  const expected = kind === "otk"
    ? receipt.binary
    : receipt.digestConsumer.path;
  if (!path || path !== expected) {
    throw new Error(
      `${key} must name its exact-tree test:prepare receipt binary`,
    );
  }
  return path;
}
