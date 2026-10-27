// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import {
  config as loadConfig,
  type CoreServer,
  type ServiceConfig,
} from "./core/mod.ts";
import { startApplication } from "./application.ts";
import {
  OpencodeV1Adapter,
  opencodeV1SessionID,
} from "@otk/harness-opencode-v1";
import { createSessionReferenceUpgrade } from "./core/features/session-ids.ts";
import { StreamBuffers } from "@otk/content";
let memo: ServiceConfig | undefined;
export function config(): ServiceConfig {
  return memo ??= loadConfig({
    defaultsPath: fromFileUrl(new URL("./defaults/otk.toml", import.meta.url)),
    overlayPath: fromFileUrl(new URL("./config/otk.toml", import.meta.url)),
    env: Deno.env.toObject(),
  });
}
export async function start(cfg: ServiceConfig): Promise<CoreServer> {
  if (cfg.harness.type !== "opencode-v1") {
    throw new Error(
      `harness.type (OTK_HARNESS_TYPE): unsupported backend ${cfg.harness.type}`,
    );
  }
  return await startApplication(
    cfg,
    new OpencodeV1Adapter(cfg, new StreamBuffers()),
    fromFileUrl(new URL("./web/dist/", import.meta.url)),
    { upgrade: createSessionReferenceUpgrade(opencodeV1SessionID.legacy) },
  );
}
if (import.meta.main) {
  try {
    const app = await start(config());
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.stop();
      Deno.exit();
    };
    Deno.addSignalListener("SIGTERM", stop);
    Deno.addSignalListener("SIGINT", stop);
  } catch (error) {
    console.error(error);
    Deno.exit(1);
  }
}
