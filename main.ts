// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import {
  config as loadConfig,
  type CoreServer,
  type DiagnosticSink,
  isCancellation,
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
import { createOpencodeV2Upgrade } from "./core/features/opencode-v2-upgrade.ts";
import { StreamBuffers } from "@otk/content";
import { IndexStore } from "./core/index/store.ts";
import { DigestBridge } from "./core/digest/bridge.ts";
import { digestProgressSource } from "./core/features/digest-progress.ts";
import type { ServingDiagnostics } from "./core/diagnostics.ts";
import { diagnosticsLog } from "./core/diagnostics-log.ts";
import {
  opencodeV2ReadCodecs,
  OpencodeV2ServerAdapter,
  opencodeV2SessionID,
} from "@otk/harness-opencode-v2-server";
import { selectHarness } from "./harness-selection.ts";
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
  signal?: AbortSignal,
  diagnostic: DiagnosticSink = diagnosticsLog(cfg.log.level),
): Promise<CoreServer> {
  const selected = await selectHarness(
    cfg.harness,
    Deno.env.toObject(),
    signal,
  );
  if (selected.kind === "opencode-v2-server") {
    const index = new IndexStore(diagnostics?.section);
    const digest = new DigestBridge({
      reads: opencodeV2ReadCodecs,
      statePath: cfg.state.path,
      provider: "opencode-v2-server",
      native: {
        serviceFile: selected.file,
        db: harnessDb(cfg),
        requestms: cfg.harness.requestms,
        attachments: cfg.attachments,
      },
      policy: cfg.digest,
      section: diagnostics?.section,
      pressure: diagnostics?.pressure,
      admission: diagnostics?.admission,
      metadata: (entries) => {
        for (const entry of entries) {
          const current = index.getMetadata(entry.id);
          index.upsertMetadata(
            current && current.timeUpdated > entry.timeUpdated
              ? current
              : current
              ? {
                ...entry,
                status: current.status,
                retry: current.retry,
                attention: current.attention,
                activityAuthority: current.activityAuthority,
                activity: {
                  ...entry.activity,
                  ...current.activity,
                  terminal: Math.max(
                    entry.activity?.terminal ?? 0,
                    current.activity?.terminal ?? 0,
                  ),
                },
              }
              : entry,
          );
        }
      },
      publish: ({ sessionID, revision, delta }) => {
        index.applyDigest({ id: sessionID, revision, ...delta });
      },
      unready: (keys) => {
        for (const id of keys) {
          const entry = index.get(id);
          if (entry) {
            const { turns: _turns, ...summary } = entry.digest;
            index.applyDigest({
              id,
              revision: summary.revision,
              summary: { ...summary, state: "digesting" },
              turns: { upsert: {}, remove: [] },
              deleted: entry.deleted ?? null,
            });
          }
        }
      },
      diagnostic: (error) => diagnostic("warn", "session digest", error),
    });
    const backend = new OpencodeV2ServerAdapter(
      {
        serviceFile: selected.file,
        harness: cfg.harness,
        messages: cfg.messages,
        digest: cfg.digest,
        catalogs: cfg.catalogs,
        attachments: cfg.attachments,
      },
      selected.service,
      (error) => diagnostic("warn", "opencode V2", error),
      fetch,
      digest,
    );
    return await startApplication(
      cfg,
      backend,
      fromFileUrl(new URL("./web/dist/", import.meta.url)),
      {
        diagnostic,
        signal,
        index,
        interactive: (owner, active) => digest.interactive(owner, active),
        requested: () => digest.requested(),
        attention: (id) => digest.attention(id),
        discoveryProject: (directory, active) =>
          digest.discoveryProject(directory, active),
        sources: [digestProgressSource(digest)],
        upgrade: async (store) => {
          try {
            await createOpencodeV2Upgrade(digest, {
              source: (value) => {
                try {
                  return opencodeV1SessionID.decode(value);
                } catch {
                  return undefined;
                }
              },
              target: opencodeV2SessionID.encode,
            }, signal)(store);
          } catch (error) {
            await digest.stop();
            throw error;
          }
        },
      },
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
      attachments: cfg.attachments,
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
              activityAuthority: current.activityAuthority,
              activity: {
                ...entry.activity,
                ...current.activity,
                terminal: Math.max(
                  entry.activity?.terminal ?? 0,
                  current.activity?.terminal ?? 0,
                ),
              },
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
    diagnostic: (error) => diagnostic("warn", "session digest", error),
  });
  const backend = new OpencodeV1Adapter(
    cfg,
    new StreamBuffers(),
    fetch,
    digest,
    diagnostic,
  );
  return await startApplication(
    cfg,
    backend,
    fromFileUrl(new URL("./web/dist/", import.meta.url)),
    {
      upgrade: createSessionReferenceUpgrade(opencodeV1SessionID.legacy),
      index,
      interactive: (owner, active) => digest.interactive(owner, active),
      requested: () => digest.requested(),
      attention: (sessionID) => digest.attention(sessionID),
      discoveryProject: (directory, active) =>
        digest.discoveryProject(directory, active),
      diagnostics: diagnostics?.section,
      diagnostic,
      signal,
      sources: [digestProgressSource(digest)],
    },
  );
}
if (import.meta.main) {
  const lifetime = new AbortController();
  let app: CoreServer | undefined;
  let stopping: Promise<void> | undefined;
  let diagnostic = diagnosticsLog("info");
  const fail = (error: unknown) => {
    diagnostic("warn", "OTK", error);
    Deno.exitCode = 1;
  };
  const stop = () => {
    lifetime.abort();
    if (app) {
      stopping ??= app.stop();
      void stopping.catch(fail);
    }
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  try {
    const cfg = config();
    diagnostic = diagnosticsLog(cfg.log.level);
    app = await start(cfg, undefined, lifetime.signal, diagnostic);
    if (lifetime.signal.aborted) stop();
    await app.server.finished;
    await stopping;
  } catch (error) {
    if (!isCancellation(error)) fail(error);
  } finally {
    Deno.removeSignalListener("SIGTERM", stop);
    Deno.removeSignalListener("SIGINT", stop);
  }
}
