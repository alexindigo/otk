// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentOp } from "./content.ts";
import type { IndexEntry, IndexOp } from "./index.ts";
import type { Preferences } from "./prefs.ts";
import type { InboxSnapshot } from "./inbox.ts";
import type { ApprovalSnapshot } from "./approvals.ts";
import { type CapabilityName, legacyCapabilities } from "./capabilities.ts";
export const MAX_CLIENT_FRAME_BYTES: number = 64 * 1024 * 1024;
export function checkClientFrameSize(serialized: string): void {
  if (
    serialized.length >= MAX_CLIENT_FRAME_BYTES ||
    new TextEncoder().encode(serialized).byteLength >= MAX_CLIENT_FRAME_BYTES
  ) {
    throw new Error(
      "Combined request exceeds 64 MiB; remove attachments or shorten the prompt",
    );
  }
}
export type HarnessState = "connecting" | "connected" | "reconnecting";
export type ClientFrame =
  | { t: "hello"; protocol: number }
  | { t: "pong" }
  | { t: "subscribe" | "unsubscribe"; sessionID: string }
  | { t: "resnapshot" }
  | { t: "rpc"; id: string; method: string; params: unknown };
export type ServerFrame =
  | {
    t: "welcome";
    protocol: number;
    sidecar: {
      version: string;
      harness: {
        kind: string;
        version: string;
        url: string;
        capabilities?: CapabilityName[];
      };
    };
  }
  | { t: "harness"; state: HarnessState }
  | { t: "ping" }
  | { t: "prefs"; prefs: Preferences }
  | { t: "inbox"; inbox: InboxSnapshot }
  | { t: "approvals"; approvals: ApprovalSnapshot }
  | { t: "approval.activity"; sessions: string[] }
  | { t: "index.snapshot"; rev: number; entries: IndexEntry[] }
  | { t: "index.patch"; rev: number; ops: IndexOp[] }
  | { t: "content"; sessionID: string; event: ContentOp }
  | { t: "resync"; sessionIDs: "all" }
  | { t: "rpc.result"; id: string; ok: true; result: unknown }
  | {
    t: "rpc.result";
    id: string;
    ok: false;
    error: { code: string; message: string };
  }
  | { t: "error"; code: string; message?: string };

// Before capability advertisement, these RPC families were always exposed by
// the wire contract. A missing field is legacy; an explicit [] advertises none.
export function welcomeCapabilities(
  frame: Extract<ServerFrame, { t: "welcome" }>,
): readonly CapabilityName[] {
  return frame.sidecar.harness.capabilities ?? legacyCapabilities;
}
