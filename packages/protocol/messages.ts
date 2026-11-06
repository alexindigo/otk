// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentOp } from "./content.ts";
import type { IndexEntry, IndexOp } from "./index.ts";
import type { Preferences } from "./prefs.ts";
import type { InboxBaseline, InboxOp } from "./inbox.ts";
import type { CatalogChunk, DirectoryCatalog } from "./catalogs.ts";
import type { AttachmentPolicy } from "./policies/attachments.ts";
import type { ApprovalSnapshot } from "./approvals.ts";
import type {
  ContentClock,
  MessagePolicy,
  TranscriptInvalidation,
} from "./transcript.ts";
import { type CapabilityName, legacyCapabilities } from "./capabilities.ts";
import type {
  ClientRequestPolicy,
  RequestControl,
  RequestEvent,
  RequestWindow,
} from "./requests.ts";
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
  | RequestControl
  | { t: "hello"; protocol: number; view?: import("./view.ts").ViewLease }
  | ({ t: "view" } & import("./view.ts").ViewLease)
  | { t: "index.applied"; epoch: number; rev: number }
  | { t: "pong" }
  | { t: "subscribe" | "unsubscribe"; sessionID: string }
  | { t: "resnapshot" };
export type ServerFrame = ServerMessage & { epoch?: number };
type ServerMessage =
  | RequestEvent
  | {
    t: "welcome";
    protocol: number;
    messages: MessagePolicy;
    attachments?: AttachmentPolicy & { uploadbytes: number };
    requests: {
      window: RequestWindow;
      policy: ClientRequestPolicy;
      principal: string;
    };
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
  | ({ t: "inbox.snapshot" } & InboxBaseline)
  | {
    t: "inbox.summaries";
    generation: string;
    from: number;
    revision: number;
    summaries: import("./inbox.ts").ProjectSummary[];
    remove?: string[];
  }
  | {
    t: "inbox.patch";
    generation: string;
    from: number;
    revision: number;
    ops: InboxOp[];
  }
  | { t: "catalog.snapshot"; catalog: DirectoryCatalog }
  | CatalogChunk
  | {
    t: "frecency.patch";
    directory: string;
    revision: number;
    upsert: import("./rpc.ts").FrecencyEntry[];
    remove: string[];
  }
  | { t: "approvals"; approvals: ApprovalSnapshot }
  | { t: "approval.activity"; sessions: string[] }
  | { t: "index.snapshot"; rev: number; entries: IndexEntry[]; epoch?: number }
  | {
    t: "index.patch";
    rev: number;
    from?: number;
    ops: IndexOp[];
    epoch?: number;
  }
  | {
    t: "view.rows";
    epoch: number;
    directory: string;
    first?: string;
    catalog: import("./session-list.ts").SessionStructure[];
  }
  | { t: "content"; sessionID: string; event: ContentOp; clock?: ContentClock }
  | { t: "bootstrap.complete" }
  | ({ t: "transcript.invalidated" } & TranscriptInvalidation)
  | { t: "error"; code: string; message?: string };

// A missing advertisement uses the compatibility families; an explicit []
// advertises none.
export function welcomeCapabilities(
  frame: Extract<ServerFrame, { t: "welcome" }>,
): readonly CapabilityName[] {
  return frame.sidecar.harness.capabilities ?? legacyCapabilities;
}
