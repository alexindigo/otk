// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentOp } from "./content.ts";
import type { IndexEntry, IndexOp } from "./index.ts";
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
      harness: { kind: string; version: string; url: string };
    };
  }
  | { t: "harness"; state: HarnessState }
  | { t: "ping" }
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
