// SPDX-License-Identifier: LGPL-3.0-only
import { arrayReadCodec, type ProviderReadCodec } from "@otk/harness";
declare module "@otk/harness" {
  interface ProviderReadKinds {
    "opcv2.upgrade": {
      input: { ids: string[] };
      result: string[];
      chunk: string[];
    };
  }
}
export const upgradeReadCodec: ProviderReadCodec<"opcv2.upgrade"> =
  arrayReadCodec<string>();
