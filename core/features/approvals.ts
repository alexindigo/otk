// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import {
  type ApprovalSnapshot,
  autoApproveOwner,
  canAutoApprove,
  type PermissionActivityPage,
  type PermissionReply,
  type PermissionRequest,
  type PermissionsCapability,
  type ServerFrame,
} from "@otk/protocol";
import type { PermissionStore } from "@otk/store";
import type { IndexStore } from "../index/store.ts";
import type { FrameSource } from "../ws/connections.ts";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";

/** Server-owned approvals, independent of browser connections/subscriptions. */
export class PermissionFeature implements FrameSource {
  #listeners = new Set<(frame: ServerFrame) => void>();
  #flights = new Set<string>();
  #failed = new Map<string, string>();
  #generation = 0;
  #scans = new Map<string, { again: boolean }>();
  #closed = false;
  #scheduled = false;
  #revision = 0;
  #stops: (() => void)[];
  constructor(
    readonly store: PermissionStore,
    readonly index: IndexStore,
    readonly capability: PermissionsCapability,
  ) {
    this.#stops = [
      index.observe(() => this.#schedule()),
      index.listen((frame) => {
        if (frame.t === "index.snapshot") {
          this.#generation++;
          this.#failed.clear();
        }
        if (frame.t === "index.patch") {
          for (const op of frame.ops) {
            if (op.op === "remove") this.store.setAuto(op.id, false);
          }
        }
      }),
      store.listen((change) => {
        if (change.kind === "policy") this.#revision++;
        const frame: ServerFrame = change.kind === "policy"
          ? this.snapshot()
          : { t: "approval.activity", sessions: change.sessions };
        for (const listener of this.#listeners) listener(frame);
      }),
    ];
  }
  get(): ApprovalSnapshot {
    return { enabled: this.store.enabled(), revision: this.#revision };
  }
  snapshot(): ServerFrame {
    return { t: "approvals", approvals: this.get() };
  }
  listen(listener: (frame: ServerFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  close(): void {
    this.#closed = true;
    for (const stop of this.#stops) stop();
    this.#listeners.clear();
    this.#failed.clear();
  }
  owner(id: string): string | undefined {
    return autoApproveOwner(
      id,
      this.store.enabled(),
      (id) => this.index.get(id),
    );
  }
  #schedule(): void {
    if (this.#closed || this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      const enabled = this.store.enabled(), owners = new Set<string>();
      if (!enabled.length) return;
      for (const entry of this.index.values()) {
        if (!entry.attention.permissions && !entry.attention.childPermissions) {
          continue;
        }
        const owner = autoApproveOwner(
          entry.id,
          enabled,
          (id) => this.index.get(id),
        );
        if (owner) owners.add(owner);
      }
      for (const owner of owners) this.#scan(owner);
    });
  }
  #scan(root: string): void {
    const running = this.#scans.get(root);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: true };
    this.#scans.set(root, state);
    void (async () => {
      try {
        while (state.again && !this.#closed) {
          state.again = false;
          const generation = this.#generation;
          const requests = await this.capability.listPermissions(root);
          for (const request of requests) {
            if (this.#closed) return;
            const owner = this.owner(request.sessionID);
            if (!owner || this.store.confirmed(request.sessionID, request.id)) {
              continue;
            }
            const key = JSON.stringify([request.sessionID, request.id]);
            const fingerprint = JSON.stringify(request);
            if (generation !== this.#generation) {
              state.again = true;
              break;
            }
            if (this.#failed.get(key) === fingerprint) continue;
            if (this.#flights.has(key)) continue;
            try {
              await this.#answer(request, {
                sessionID: request.sessionID,
                requestID: request.id,
                reply: "once",
              }, owner);
            } catch (error) {
              if (generation === this.#generation) {
                this.#failed.set(key, fingerprint);
              }
              if (!this.#closed) console.error("permission auto reply:", error);
            }
          }
        }
      } catch (error) {
        if (!this.#closed) console.error("permission auto list:", error);
      } finally {
        this.#scans.delete(root);
      }
    })();
  }
  async reply(input: PermissionReply): Promise<void> {
    const requests = await this.capability.listPermissions(input.sessionID);
    const request = requests.find((request) =>
      request.id === input.requestID && request.sessionID === input.sessionID
    );
    if (!request) {
      throw new HarnessError(
        "permission",
        "Permission request is no longer pending in this session",
      );
    }
    await this.#answer(request, input);
  }
  async #answer(
    request: PermissionRequest,
    input: PermissionReply,
    owner?: string,
  ): Promise<void> {
    const key = JSON.stringify([request.sessionID, request.id]);
    if (this.#closed) {
      throw new HarnessError("permission", "Server is stopping");
    }
    if (
      this.#flights.has(key) ||
      this.store.confirmed(request.sessionID, request.id)
    ) {
      throw new HarnessError(
        "permission",
        "Permission request is already being answered",
      );
    }
    // There is no await between this final policy check and dispatch.
    if (owner && this.owner(request.sessionID) !== owner) return;
    this.#flights.add(key);
    let journal: number | undefined;
    try {
      journal = this.store.start({
        session: request.sessionID,
        requestID: request.id,
        request: JSON.stringify(request),
        reply: input.reply,
        source: owner ? "auto" : "manual",
        owner,
        message: input.message,
      }, this.index.ancestors(request.sessionID));
      await this.capability.replyPermission(input);
      if (!this.#closed) this.store.finish(journal, { outcome: "confirmed" });
    } catch (error) {
      if (!this.#closed && journal !== undefined) {
        this.store.finish(journal, {
          outcome: "failed",
          error: error instanceof Error
            ? error.message
            : typeof error === "string"
            ? error
            : "Permission reply failed",
        });
      }
      throw error;
    } finally {
      this.#flights.delete(key);
    }
  }
  register(rpc: RpcRegistry): void {
    rpc.register("permission.auto", {
      params(p) {
        if (typeof p.enabled !== "boolean") {
          throw new HarnessError("params", "Expected enabled boolean");
        }
        return { sessionID: text(p, "sessionID")!, enabled: p.enabled };
      },
      handler: async (ctx, input) => {
        if (
          input.enabled &&
          !canAutoApprove(await ctx.harness.core.getSession(input.sessionID))
        ) {
          throw new HarnessError(
            "permission",
            "Cannot enable auto-approve on a helper session; it inherits its parent policy",
          );
        }
        if (this.#closed) {
          throw new HarnessError("permission", "Server is stopping");
        }
        this.store.setAuto(input.sessionID, input.enabled);
        if (input.enabled) this.#scan(input.sessionID);
        return this.get();
      },
    });
    rpc.register("permission.activity", {
      params(p) {
        if (
          p.before !== undefined &&
          (!Number.isSafeInteger(p.before) || Number(p.before) <= 0)
        ) throw new HarnessError("params", "Expected positive activity cursor");
        return {
          sessionID: text(p, "sessionID")!,
          before: p.before as number | undefined,
        };
      },
      handler: (_ctx, input): PermissionActivityPage => {
        const rows = this.store.list([input.sessionID], input.before);
        const entries = rows.slice(0, 100).map((row) => ({
          id: row.id,
          request: JSON.parse(row.request) as PermissionRequest,
          reply: row.reply,
          source: row.source,
          owner: row.owner,
          message: row.message,
          time: row.time,
          outcome: row.outcome,
          error: row.error,
        }));
        return {
          entries,
          before: rows.length > 100 ? entries.at(-1)!.id : undefined,
        };
      },
    });
  }
}
