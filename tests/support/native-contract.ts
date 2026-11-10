// SPDX-License-Identifier: LGPL-3.0-only
import { nativeKind } from "./native.ts";
import { withResources } from "./resources.ts";

/** Version-specific native contracts require an explicit, runnable counterpart.
 * Backend-neutral behavior tests use resources.test and the semantic native seam.
 */
export function v1NativeTests(reason: string, counterparts: string[]) {
  if (!reason || !counterparts.length) {
    throw new Error("Native coverage must be explicit");
  }
  for (const counterpart of counterparts) {
    const [path, contract] = counterpart.split("#");
    if (!contract || !Deno.readTextFileSync(path).includes(contract)) {
      throw new Error(`Missing V2 counterpart: ${counterpart}`);
    }
  }
  return (
    name: string,
    run: (context: Deno.TestContext) => void | Promise<void>,
  ) => {
    const label = `[V1 native contract] ${name}`;
    Deno.test({
      name: label,
      ignore: nativeKind !== "opencode-v1",
      fn: (context) => withResources(label, () => run(context)),
    });
  };
}
