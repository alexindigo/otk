// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import type { MessagePolicy } from "@otk/protocol";

/** Native adapter inputs, independent of sidecar configuration/auth/state. */
export interface OpencodeV1Config {
  harness: {
    url: string;
    username: string;
    password: string;
    db: string;
    heartbeattimeout: number;
    reconnectmax: number;
  };
  index: { days: number };
}
export type OpencodeV1AdapterConfig = OpencodeV1Config & {
  messages: MessagePolicy;
};
export function harnessDb(
  cfg: Pick<OpencodeV1Config, "harness">,
  env: Record<string, string> = Deno.env.toObject(),
): string {
  return cfg.harness.db ||
    join(
      env.XDG_DATA_HOME || join(env.HOME!, ".local/share"),
      "opencode/opencode.db",
    );
}
