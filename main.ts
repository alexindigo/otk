// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import {
  config as loadConfig,
  type CoreServer,
  type ServiceConfig,
} from "./core/mod.ts";
import { startApplication } from "./application.ts";
import {
  harnessDb,
  OpencodeV1Adapter,
  opencodeV1ReadCodecs,
  opencodeV1SessionID,
} from "@otk/harness-opencode-v1";
import { createSessionReferenceUpgrade } from "./core/features/session-ids.ts";
import { StreamBuffers } from "@otk/content";
import { IndexStore } from "./core/index/store.ts";
import { DigestBridge } from "./core/digest/bridge.ts";
import type { ServingDiagnostics } from "./core/diagnostics.ts";
let memo: ServiceConfig | undefined;
export function config(): ServiceConfig {
  return memo ??= loadConfig({
    defaultsPath: fromFileUrl(new URL("./defaults/otk.toml", import.meta.url)),
    overlayPath: fromFileUrl(new URL("./config/otk.toml", import.meta.url)),
    env: Deno.env.toObject(),
  });
}
export async function start(
  cfg: ServiceConfig,
  diagnostics?: ServingDiagnostics,
): Promise<CoreServer> {
  if (cfg.harness.type !== "opencode-v1") {
    throw new Error(
      `harness.type (OTK_HARNESS_TYPE): unsupported backend ${cfg.harness.type}`,
    );
  }
  const index = new IndexStore(diagnostics?.section);
  const digest = new DigestBridge({
    reads: opencodeV1ReadCodecs,
    statePath: cfg.state.path,
    provider: "opencode-v1",
    native: {
      harness: {
        url: cfg.harness.url,
        username: cfg.harness.username,
        password: cfg.harness.password,
        db: harnessDb(cfg),
        heartbeattimeout: cfg.harness.heartbeattimeout,
        reconnectmax: cfg.harness.reconnectmax,
        requestms: cfg.harness.requestms,
      },
      index: cfg.index,
    },
    policy: cfg.digest,
    section: diagnostics?.section,
    pressure: diagnostics?.pressure,
    admission: diagnostics?.admission,
    metadata: (entries) => {
      for (const entry of entries) {
        const current = index.get(entry.id);
        index.upsertMetadata(
          current
            ? {
              ...entry,
              status: current.status,
              retry: current.retry,
              attention: current.attention,
            }
            : entry,
        );
      }
    },
    publish: ({ sessionID, revision, delta }) => {
      const wasDeleted = !!index.get(sessionID)?.deleted;
      if (index.applyDigest({ id: sessionID, revision, ...delta })) {
        if (delta.deleted) backend.retireSession(sessionID);
        else if (wasDeleted) backend.restoreSession(sessionID);
      }
    },
    unready: (ids) => {
      for (const id of ids) {
        const entry = index.get(id);
        if (entry) {
          const { turns: _turns, ...summary } = entry.digest;
          index.applyDigest({
            id,
            revision: entry.digest.revision,
            summary: { ...summary, state: "digesting" },
            turns: { upsert: {}, remove: [] },
            deleted: entry.deleted ?? null,
          });
        }
      }
    },
    diagnostic: (error) => console.warn("session digest:", error),
  });
  const backend = new OpencodeV1Adapter(
    cfg,
    new StreamBuffers(),
    fetch,
    digest,
  );
  return await startApplication(
    cfg,
    backend,
    fromFileUrl(new URL("./web/dist/", import.meta.url)),
    {
      upgrade: createSessionReferenceUpgrade(opencodeV1SessionID.legacy),
      index,
      interactive: (owner, active) => digest.interactive(owner, active),
      attention: (sessionID) => digest.attention(sessionID),
      diagnostics: diagnostics?.section,
    },
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
