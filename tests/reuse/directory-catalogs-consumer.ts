// SPDX-License-Identifier: LGPL-3.0-only
/** Plain public package consumer: no application/store/HTTP composition. */
import {
  OpencodeV1Adapter,
  type OpencodeV1AdapterConfig,
} from "@otk/harness-opencode-v1";
export function catalogConsumer(
  config: OpencodeV1AdapterConfig,
  fetcher = fetch,
): OpencodeV1Adapter {
  return new OpencodeV1Adapter(config, undefined, fetcher);
}
