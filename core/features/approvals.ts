// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import { ACTIVITY_PAGE_SIZE, OperationFailure } from "@otk/protocol";
import {
  type ApprovalSnapshot,
  autoApproveOwner,
  canAutoApprove,
  isSessionID,
  type OperationContext,
  type PermissionActivityPage,
  type PermissionReply,
  type PermissionRequest,
  type PermissionsCapability,
  type ServerFrame,
  type ViewLease,
} from "@otk/protocol";
import type { PermissionStore } from "@otk/store";
import type { IndexStore } from "../index/store.ts";
import type { FrameSource } from "../ws/connections.ts";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID } from "../ws/params.ts";
import {
  localWrite,
  metadataReceipt,
  preparedLocalExecution,
  readExecution,
} from "../requests/policies.ts";
import { object } from "../ws/params.ts";

const policyReceipt = metadataReceipt("approval-policy", (value) => {
  const snapshot = object(value);
  if (
    !Array.isArray(snapshot.enabled) || !snapshot.enabled.every(isSessionID) ||
    !Number.isSafeInteger(snapshot.revision) || Number(snapshot.revision) < 0
  ) {
    throw new TypeError("Invalid approval policy receipt");
  }
  return {
    enabled: [...snapshot.enabled] as string[],
    revision: Number(snapshot.revision),
  };
});

/** Server-owned approvals, independent of browser connections/subscriptions. */
export class PermissionFeature implements FrameSource {
  #inView(id: string, view: ViewLease): boolean {
    if (
      id === view.selected || view.crumbs.includes(id) || view.rows.includes(id)
    ) return true;
    const directory = view.directory ??
      (view.selected && this.index.getMetadata(view.selected)?.directory);
    return !!directory && this.index.getMetadata(id)?.directory === directory;
  }
  #scoped(
    snapshot: ApprovalSnapshot,
    view?: ViewLease,
    entries?: ReadonlySet<string>,
  ): ApprovalSnapshot {
    return view
      ? {
        ...snapshot,
        enabled: snapshot.enabled.filter((id) =>
          entries ? entries.has(id) : this.#inView(id, view)
        ),
      }
      : snapshot;
  }
  open(
    view: () => ViewLease,
    _id: string,
    entries: () => ReadonlySet<string>,
  ): FrameSource {
    return {
      snapshot: () => ({
        t: "approvals",
        approvals: this.#scoped(this.get(), view(), entries()),
      }),
      listen: (listener) =>
        this.listen((frame) => {
          if (frame.t === "approvals") {
            listener({
              ...frame,
              approvals: this.#scoped(frame.approvals, view(), entries()),
            });
          } else if (frame.t === "approval.activity") {
            const sessions = frame.sessions.filter((id) => entries().has(id));
            if (sessions.length) listener({ ...frame, sessions });
          }
        }),
    };
  }
  #listeners = new Set<(frame: ServerFrame) => void>();
  #flights = new Set<string>();
  #failed = new Map<string, string>();
  #generation = 0;
  #scans = new Map<string, { again: boolean }>();
  #enabled: Set<string>;
  #dirty = new Set<string>();
  #journal = new Map<string, "started" | "confirmed" | undefined>();
  #pending = new Map<string, Set<string>>();
  #closed = false;
  #scheduled = false;
  #revision = 0;
  #controller = new AbortController();
  #requestIdentity = crypto.randomUUID();
  #stops: (() => void)[];
  constructor(
    readonly store: PermissionStore,
    readonly index: IndexStore,
    readonly capability: PermissionsCapability,
  ) {
    this.#enabled = new Set(store.enabled());
    this.#stops = [
      index.observe((entry, previous, delta) => {
        if (entry.deleted) this.store.setAuto(entry.id, false);
        const topology = !previous || entry.parentID !== previous.parentID ||
          !!entry.deleted !== !!previous.deleted;
        if (delta && !topology) return;
        const attention = !previous ||
          entry.attention.permissions !== previous.attention.permissions ||
          entry.attention.childPermissions !==
            previous.attention.childPermissions;
        // An equal metadata publication is the native pending-inventory signal;
        // title/status/clock/digest-only publications cannot schedule a pass.
        const repeated = previous &&
          JSON.stringify({ ...entry, digest: undefined }) ===
            JSON.stringify({ ...previous, digest: undefined });
        if (!topology && !attention && !repeated) return;
        if (previous) {
          this.#enqueue(
            this.#owner(
              previous.id,
              (id) => id === previous.id ? previous : index.getMetadata(id),
            ),
          );
        }
        for (const id of topology ? index.descendants(entry.id) : [entry.id]) {
          this.#enqueue(this.owner(id));
        }
      }),
      index.listen((frame) => {
        if (frame.t === "index.snapshot") {
          this.#generation++;
          this.#failed.clear();
          this.#journal.clear();
          this.#pending.clear();
          for (const id of this.#enabled) this.#enqueue(id);
        }
      }),
      index.observeRemoval((id) => {
        this.#enqueue(this.owner(id));
        this.store.setAuto(id, false);
        for (const child of index.descendants(id)) {
          this.#enqueue(this.owner(child));
        }
      }),
      store.listen((change) => {
        if (change.kind === "policy") {
          this.#revision++;
          if (change.enabled) this.#enabled.add(change.session);
          else this.#enabled.delete(change.session);
          this.#enqueue(change.session);
        } else {
          for (const request of change.requests) {
            const key = JSON.stringify([request.session, request.requestID]);
            if (!this.#journal.has(key)) continue;
            this.#journal.set(
              key,
              request.outcome === "failed" ? undefined : request.outcome,
            );
          }
        }
        const frame: ServerFrame = change.kind === "policy"
          ? this.snapshot()
          : { t: "approval.activity", sessions: change.sessions };
        for (const listener of this.#listeners) listener(frame);
      }),
    ];
  }
  get(): ApprovalSnapshot {
    return { enabled: [...this.#enabled].sort(), revision: this.#revision };
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
    this.#controller.abort();
    for (const stop of this.#stops) stop();
    this.#listeners.clear();
    this.#failed.clear();
    this.#dirty.clear();
    this.#journal.clear();
    this.#pending.clear();
  }
  owner(id: string): string | undefined {
    if (this.index.getMetadata(id)?.deleted) return;
    return this.index.hierarchy.owner(id, this.#enabled);
  }
  #owner(
    id: string,
    lookup: (id: string) => { parentID?: string } | undefined,
  ): string | undefined {
    return autoApproveOwner(id, [...this.#enabled], lookup);
  }
  #enqueue(owner?: string): void {
    if (!owner || !this.#enabled.has(owner)) return;
    this.#dirty.add(owner);
    if (this.#closed || this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      const owners = [...this.#dirty];
      this.#dirty.clear();
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
          if (this.#closed || generation !== this.#generation) {
            state.again = !this.#closed;
            continue;
          }
          const keys = new Set(
            requests.map((request) =>
              JSON.stringify([request.sessionID, request.id])
            ),
          );
          const previous = this.#pending.get(root);
          this.#pending.set(root, keys);
          for (const key of previous ?? []) {
            if (
              keys.has(key) || this.#flights.has(key) ||
              [...this.#pending.values()].some((set) => set.has(key))
            ) continue;
            this.#journal.delete(key);
            this.#failed.delete(key);
          }
          const unknown = requests.filter((request) =>
            !this.#journal.has(JSON.stringify([request.sessionID, request.id]))
          ).map((request) => ({
            session: request.sessionID,
            requestID: request.id,
          }));
          const states = this.store.states(unknown);
          for (const request of unknown) {
            const key = JSON.stringify([request.session, request.requestID]);
            this.#journal.set(key, states[key]);
          }
          for (const request of requests) {
            if (this.#closed) return;
            const owner = this.owner(request.sessionID);
            if (
              !owner ||
              this.#journal.get(JSON.stringify([request.sessionID, request.id]))
            ) {
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
  async reply(
    input: PermissionReply,
    operation?: OperationContext,
  ): Promise<void> {
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
    await this.#answer(request, input, undefined, operation);
  }
  async #answer(
    request: PermissionRequest,
    input: PermissionReply,
    owner?: string,
    operation?: OperationContext,
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
    if (this.store.unconfirmed(request.sessionID, request.id)) {
      throw new OperationFailure(
        "unknown",
        "permission.unconfirmed",
        new Error("A previous reply has no confirmed outcome"),
      );
    }
    // There is no await between this final policy check and dispatch.
    if (owner && this.owner(request.sessionID) !== owner) return;
    this.#flights.add(key);
    const context = operation ?? (owner
      ? {
        key: {
          clientID: this.#requestIdentity,
          key: crypto.randomUUID(),
          window: this.#requestIdentity,
        },
        signal: this.#controller.signal,
        progress() {},
        beforeEffect: () => {
          if (this.#closed || this.owner(request.sessionID) !== owner) {
            throw new OperationFailure(
              "rejected",
              "permission.policy-off",
              new Error("Automatic policy changed before dispatch"),
            );
          }
          return Promise.resolve();
        },
        checkpoint: () => Promise.resolve(),
      } satisfies OperationContext
      : undefined);
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
      }, this.index.hierarchy.ancestors(request.sessionID));
      await context?.beforeEffect();
      await this.capability.replyPermission(input, context);
      if (!this.#closed) this.store.finish(journal, { outcome: "confirmed" });
    } catch (error) {
      if (
        !this.#closed && journal !== undefined &&
        (!context ||
          error instanceof OperationFailure && error.outcome === "rejected")
      ) {
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
      execution: {
        ...preparedLocalExecution(
          (p: { sessionID: string }) => ({ sessionID: p.sessionID }),
          policyReceipt,
        ),
        ordering: "target",
      },
      params(p) {
        if (typeof p.enabled !== "boolean") {
          throw new HarnessError("params", "Expected enabled boolean");
        }
        return { sessionID: sessionID(p)!, enabled: p.enabled };
      },
      handler: async (ctx, input) => {
        if (input.enabled && this.index.get(input.sessionID)?.deleted) {
          throw new HarnessError(
            "permission",
            "Deleted sessions cannot enable auto-approve",
          );
        }
        if (input.enabled) {
          const ready = ctx.harness.core.identities(
            [input.sessionID],
            ctx.execution?.signal,
          );
          const identity = (await (ctx.execution?.wait?.(ready) ?? ready)).find(
            (row) => row.id === input.sessionID,
          );
          if (!identity) {
            throw new HarnessError(
              "session",
              "That session is no longer available.",
            );
          }
          if (!canAutoApprove(identity)) {
            throw new HarnessError(
              "permission",
              "Cannot enable auto-approve on a helper session; it inherits its parent policy",
            );
          }
        }
        if (this.#closed) {
          throw new HarnessError("permission", "Server is stopping");
        }
        const result = localWrite(ctx, (tx) => {
          if (
            this.#closed ||
            input.enabled && this.index.get(input.sessionID)?.deleted
          ) {
            throw new HarnessError(
              "permission",
              "Session is no longer available",
            );
          }
          const changed = this.#enabled.has(input.sessionID) !== input.enabled;
          this.store.setAuto(input.sessionID, input.enabled, tx);
          return this.#scoped(
            {
              enabled: [
                ...new Set(
                  [...this.#enabled].filter((id) => id !== input.sessionID)
                    .concat(input.enabled ? [input.sessionID] : []),
                ),
              ].sort(),
              revision: this.#revision + (changed ? 1 : 0),
            },
            ctx.request?.view?.(),
            ctx.request?.entries?.(),
          );
        }, policyReceipt);
        return result;
      },
    });
    rpc.register("permission.activity", {
      execution: readExecution((p: { sessionID: string }) => ({
        sessionID: p.sessionID,
      })),
      params(p) {
        if (
          p.before !== undefined &&
          (!Number.isSafeInteger(p.before) || Number(p.before) <= 0)
        ) throw new HarnessError("params", "Expected positive activity cursor");
        return {
          sessionID: sessionID(p)!,
          before: p.before as number | undefined,
        };
      },
      handler: (_ctx, input): PermissionActivityPage => {
        const rows = this.store.list(
          [input.sessionID],
          input.before,
          ACTIVITY_PAGE_SIZE + 1,
        );
        const entries = rows.slice(0, ACTIVITY_PAGE_SIZE).map((row) => ({
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
          before: rows.length > ACTIVITY_PAGE_SIZE
            ? entries.at(-1)!.id
            : undefined,
        };
      },
    });
  }
}
