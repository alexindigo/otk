// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import {
  config as loadConfig,
  type CoreServer,
  frecencyOptions,
  prefsOptions,
  registerAgents,
  registerCommands,
  registerFiles,
  registerFrecency,
  registerHistory,
  registerPermissions,
  registerPrefs,
  registerPrompt,
  registerQuestions,
  registerResources,
  registerRevert,
  registerSessions,
  registerShell,
  RpcRegistry,
  type ServiceConfig,
  startCore,
} from "./core/mod.ts";
import { Opencode1Adapter } from "@otk/harness-opencode1";
import { StreamBuffers } from "@otk/content";
import {
  Frecency,
  frecencyMigrations,
  OtkDb,
  Prefs,
  prefsMigrations,
} from "@otk/store";
let memo: ServiceConfig | undefined;
export function config(): ServiceConfig {
  return memo ??= loadConfig({
    defaultsPath: fromFileUrl(new URL("./defaults/otk.toml", import.meta.url)),
    overlayPath: fromFileUrl(new URL("./config/otk.toml", import.meta.url)),
    env: Deno.env.toObject(),
  });
}
export async function start(cfg: ServiceConfig): Promise<CoreServer> {
  if (cfg.harness.type !== "opencode1") {
    throw new Error(`Unsupported backend: ${cfg.harness.type}`);
  }
  const backend = new Opencode1Adapter(cfg, new StreamBuffers());
  const db = new OtkDb(cfg.state.path, [
      ...prefsMigrations,
      ...frecencyMigrations,
    ]),
    prefs = new Prefs(db, prefsOptions);
  const rpc = new RpcRegistry(backend, db);
  registerPrefs(rpc, backend, prefs);
  registerFrecency(rpc, backend, new Frecency(db, frecencyOptions));
  registerSessions(rpc, backend);
  registerPrompt(rpc, backend);
  registerShell(rpc, backend);
  registerCommands(rpc, backend);
  registerHistory(rpc, backend);
  registerFiles(rpc, backend);
  registerAgents(rpc, backend);
  registerResources(rpc, backend);
  registerPermissions(rpc, backend);
  registerQuestions(rpc, backend);
  registerRevert(rpc, backend);
  return await startCore({
    cfg,
    backend,
    store: db,
    prefs,
    rpc,
    staticRoot: fromFileUrl(new URL("./web/dist/", import.meta.url)),
  });
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
    console.error((error as Error).message);
    Deno.exit(1);
  }
}
