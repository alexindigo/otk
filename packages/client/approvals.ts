// SPDX-License-Identifier: LGPL-3.0-only
import { errorMessage } from "@otk/protocol";
import {
  type ApprovalSnapshot,
  autoApproveOwner,
  canAutoApprove,
  type PermissionActivityPage,
  type ServerFrame,
  type SessionLookup,
} from "@otk/protocol";
import type { InboxRpc } from "./inbox.ts";
import { createState, type StateFactory } from "./state.ts";
import { approvalAttention } from "./approval-attention.ts";

export interface ApprovalState {
  ready: boolean;
  snapshot: ApprovalSnapshot;
  activity: PermissionActivityPage & {
    sessionID?: string;
    loading: boolean;
    error?: string;
  };
}
export interface ApprovalModel {
  readonly state: ApprovalState;
  subscribe(listener: (state: ApprovalState) => void): () => void;
  receive(frame: ServerFrame): void;
  owner(sessionID: string): string | undefined;
  canEnable(sessionID: string): boolean;
  attention(linked: boolean): ReturnType<typeof approvalAttention>;
  activityFor(sessionID: string): ApprovalState["activity"];
  setAuto(sessionID: string, enabled: boolean): Promise<void>;
  selectActivity(sessionID: string): Promise<void>;
  loadActivity(sessionID: string, more?: boolean): Promise<void>;
  stop(): void;
}
/** One authoritative policy/activity resource per serving sidecar, not browser policy. */
export function createApprovals(
  rpc: InboxRpc,
  lookup: SessionLookup,
  factory: StateFactory = createState,
): ApprovalModel {
  const revision = factory({ value: 0 });
  let value: ApprovalState = {
    ready: false,
    snapshot: { enabled: [], revision: -1 },
    activity: { entries: [], loading: false },
  };
  let epoch = 0, activityRevision = 0, stopped = false;
  let running:
    | { id: string; again: boolean; promise: Promise<void> }
    | undefined;
  const publish = (patch: Partial<ApprovalState>) => {
    value = { ...value, ...patch };
    revision.update((draft) => {
      draft.value++;
    });
  };
  const apply = (snapshot: ApprovalSnapshot) => {
    if (value.ready && snapshot.revision < value.snapshot.revision) return;
    const initial = !value.ready;
    publish({ ready: true, snapshot });
    const id = value.activity.sessionID;
    if (initial && id) {
      if (running?.id === id) running.again = true;
      else void model.loadActivity(id);
    }
  };
  const model: ApprovalModel = {
    get state() {
      void revision.state.value;
      return value;
    },
    subscribe: (listener) => revision.subscribe(() => listener(value)),
    owner(id) {
      return autoApproveOwner(id, model.state.snapshot.enabled, lookup);
    },
    canEnable: (id) => canAutoApprove(lookup(id)),
    attention: (linked) =>
      approvalAttention(
        model.state.snapshot.enabled,
        lookup,
        linked && model.state.ready,
      ),
    activityFor(id) {
      const current = model.state.activity;
      return current.sessionID === id
        ? current
        : { sessionID: id, entries: [], loading: model.state.ready };
    },
    receive(frame) {
      if (stopped) return;
      if (frame.t === "welcome") {
        epoch++;
        running = undefined;
        publish({
          ready: false,
          activity: { ...value.activity, loading: false },
        });
      }
      if (frame.t === "approvals") apply(frame.approvals);
      if (
        frame.t === "approval.activity" && value.activity.sessionID &&
        frame.sessions.includes(value.activity.sessionID)
      ) {
        activityRevision++;
        if (running) running.again = true;
        else void model.loadActivity(value.activity.sessionID);
      }
    },
    async setAuto(sessionID, enabled) {
      if (stopped || !value.ready) {
        throw new Error("Session approvals are unavailable");
      }
      const generation = epoch;
      const result = await rpc.call("permission.auto", { sessionID, enabled });
      if (!stopped && generation === epoch) apply(result);
    },
    selectActivity(id) {
      return value.activity.sessionID === id
        ? running?.promise ?? Promise.resolve()
        : model.loadActivity(id);
    },
    loadActivity(id, more = false) {
      if (stopped || !value.ready) return Promise.resolve();
      if (running?.id === id) return running.promise;
      const generation = epoch, snapshot = activityRevision;
      const before = more && value.activity.sessionID === id
        ? value.activity.before
        : undefined;
      const previous = value.activity.sessionID === id
        ? value.activity.entries
        : [];
      const flight = { id, again: false, promise: Promise.resolve() };
      running = flight;
      flight.promise = Promise.resolve().then(async () => {
        try {
          const result = await rpc.call("permission.activity", {
            sessionID: id,
            ...(before ? { before } : {}),
          });
          if (stopped || epoch !== generation || running !== flight) return;
          if (snapshot !== activityRevision) {
            flight.again = true;
            return;
          }
          publish({
            activity: {
              sessionID: id,
              entries: before
                ? [...previous, ...result.entries]
                : result.entries,
              before: result.before,
              loading: false,
            },
          });
        } catch (error) {
          if (!stopped && epoch === generation && running === flight) {
            publish({
              activity: {
                ...value.activity,
                loading: false,
                error: errorMessage(error),
              },
            });
          }
        } finally {
          if (!stopped && epoch === generation && running === flight) {
            running = undefined;
            publish({ activity: { ...value.activity, loading: false } });
            if (flight.again) await model.loadActivity(id);
          }
        }
      });
      publish({
        activity: {
          sessionID: id,
          entries: previous,
          before: value.activity.sessionID === id
            ? value.activity.before
            : undefined,
          loading: true,
        },
      });
      return flight.promise;
    },
    stop() {
      stopped = true;
      epoch++;
      running = undefined;
    },
  };
  return model;
}
