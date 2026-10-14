// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";

/** Native adapter inputs, independent of sidecar configuration/auth/state. */
export interface Opencode1Config {
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
export function harnessDb(
  cfg: Pick<Opencode1Config, "harness">,
  env: Record<string, string> = Deno.env.toObject(),
): string {
  return cfg.harness.db ||
    join(
      env.XDG_DATA_HOME || join(env.HOME!, ".local/share"),
      "opencode/opencode.db",
    );
}
