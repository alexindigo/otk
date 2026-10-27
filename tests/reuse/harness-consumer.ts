// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness, HarnessSink } from "@otk/harness";
import {
  OpencodeV1Adapter as Opencode1Adapter,
  type OpencodeV1Config as Opencode1Config,
} from "@otk/harness-opencode-v1";

/** Standalone consumer: no sidecar, HTTP routes, store or app configuration. */
export async function listSessions(
  config: Opencode1Config,
): Promise<Parameters<HarnessSink["indexReset"]>[0]> {
  const harness: Harness = new Opencode1Adapter(config);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Parameters<HarnessSink["indexReset"]>[0]>(
      (resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Harness index did not arrive")),
          30_000,
        );
        harness.core.start({
          connection: () => {},
          indexReset: resolve,
          indexUpsert: () => {},
          indexRemove: () => {},
          content: () => {},
          resync: () => {},
        }).catch(reject);
      },
    );
  } finally {
    clearTimeout(timer);
    await harness.core.stop();
  }
}
