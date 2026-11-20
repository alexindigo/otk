// SPDX-License-Identifier: LGPL-3.0-only
// Wire shapes from @opencode/pty 0.5.0 src/protocol.rs (MIT), protocol 8.
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export type Role = "controller" | "observer";
export type Lifecycle = { status: "running" } | {
  status: "exited";
  exit_code: number | null;
  signal?: string;
} | { status: "failed"; message: string };
export interface ProcessInfo {
  id: number;
  mode: "pty" | "pipe";
  pid: number | null;
  command: string[];
  cwd: string;
  group_id: string;
  lifecycle: Lifecycle;
  output_head: bigint;
  output_tail: bigint;
  started_at: number;
  exited_at: number | null;
  pty?: {
    title: string;
    user_title: string | null;
    foreground_process: string | null;
    cols: number;
    rows: number;
  };
  pipe?: {
    output_path: string;
    output_lines: number;
    output_error?: string;
    metadata: Record<string, unknown>;
  };
}
type Program = {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  group_id: string;
};
export type Request =
  | { op: "ping" | "prepare_handoff" | "shutdown" }
  | { op: "own"; instance_id: string; ticket: string | null }
  | ({ op: "create_pty"; title: string; cols: number; rows: number } & Program)
  | ({
    op: "create_pipe";
    output_path: string;
    metadata: Record<string, unknown>;
  } & Program)
  | { op: "list"; mode: "pty" | "pipe" }
  | { op: "get" | "wait" | "snapshot" | "terminate"; id: number }
  | { op: "signal"; id: number; signal: "SIGTERM" | "SIGINT" | "SIGKILL" }
  | { op: "set_metadata"; id: number; metadata: Record<string, unknown> }
  | {
    op: "write";
    id: number;
    attachment_id: string | null;
    data_base64: string;
  }
  | {
    op: "resize";
    id: number;
    attachment_id: string | null;
    cols: number;
    rows: number;
  }
  | {
    op: "control";
    id: number;
    attachment_id: string;
    cols: number;
    rows: number;
  }
  | {
    op: "input";
    id: number;
    attachment_id: string;
    cols: number;
    rows: number;
    data_base64: string;
  }
  | { op: "read_rows"; id: number; rows: number | null }
  | { op: "rename"; id: number; title: string | null }
  | { op: "replay"; id: number; offset: bigint }
  | {
    op: "subscribe";
    id: number;
    offset: bigint;
    attachment_id: string;
    role: Role;
    takeover: boolean;
  };
type Replay = {
  requested_offset: bigint;
  available_offset: bigint;
  end_offset: bigint;
  truncated: boolean;
};
export type Response =
  | { type: "owned" | "ok" }
  | { type: "handoff"; ticket: string; expires_at: number }
  | {
    type: "pong";
    instance_id: string;
    pid: number;
    protocol: number;
    features: string[];
  }
  | { type: "created" | "process"; process: ProcessInfo }
  | { type: "processes"; processes: ProcessInfo[] }
  | {
    type: "snapshot";
    process: ProcessInfo;
    text: string;
    checkpoint_base64: string;
    cursor_x: number;
    cursor_y: number;
  }
  | {
    type: "rows";
    process: ProcessInfo;
    lines: string[];
    cursor_x: number;
    cursor_y: number;
  }
  | ({ type: "replay"; data_base64: string } & Replay)
  | ({
    type: "attached";
    process: ProcessInfo;
    role: Role;
    generation: number;
    replay_base64: string;
  } & Replay)
  | {
    type: "resized";
    cols: number;
    rows: number;
    generation: number;
    checkpoint_base64: string;
  }
  | {
    type: "exited";
    exit_code: number | null;
    signal?: string;
    final_offset: bigint;
    output_lines?: number;
    output_error?: string;
    exited_at: number;
  }
  | {
    type: "controller_changed";
    attachment_id: string | null;
    generation: number;
  }
  | { type: "title_changed"; title: string }
  | { type: "foreground_process_changed"; process: string | null }
  | { type: "error"; message: string };
export type Frame = { kind: "json"; value: Response } | {
  kind: "output";
  start: bigint;
  end: bigint;
  bytes: Uint8Array;
};
const offsets = new Set([
  "output_head",
  "output_tail",
  "requested_offset",
  "available_offset",
  "end_offset",
  "final_offset",
]);

export function encodeRequest(token: string, request: Request): Uint8Array {
  const json = JSON.stringify({ token, request }, (_, value) => {
    if (typeof value === "bigint") {
      if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("JSON offset exceeds safe integer range");
      }
      return Number(value);
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error("Unsafe protocol integer");
    }
    return value;
  });
  const body = new TextEncoder().encode(json);
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error("Request exceeds frame limit");
  }
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/** Copies only the current frame, so arbitrarily coalesced socket chunks stay bounded. */
export class FrameDecoder {
  #header = new Uint8Array(4);
  #headerSize = 0;
  #body?: Uint8Array;
  #size = 0;
  #failed = false;
  push(chunk: Uint8Array): Frame[] {
    if (this.#failed) throw new Error("Frame decoder is failed");
    const frames: Frame[] = [];
    try {
      let cursor = 0;
      while (cursor < chunk.length) {
        if (!this.#body) {
          const count = Math.min(4 - this.#headerSize, chunk.length - cursor);
          this.#header.set(
            chunk.subarray(cursor, cursor + count),
            this.#headerSize,
          );
          cursor += count;
          this.#headerSize += count;
          if (this.#headerSize < 4) continue;
          const length = new DataView(this.#header.buffer).getUint32(0, false);
          if (length === 0 || length > MAX_FRAME_BYTES) {
            throw new Error("Invalid frame length");
          }
          this.#body = new Uint8Array(length);
        }
        const count = Math.min(
          this.#body.length - this.#size,
          chunk.length - cursor,
        );
        this.#body.set(chunk.subarray(cursor, cursor + count), this.#size);
        cursor += count;
        this.#size += count;
        if (this.#size !== this.#body.length) continue;
        const body = this.#body;
        if (body[0] === 0) {
          if (body.length < 17) throw new Error("Invalid output frame");
          const view = new DataView(body.buffer);
          const start = view.getBigUint64(1, false),
            end = view.getBigUint64(9, false);
          if (end - start !== BigInt(body.length - 17)) {
            throw new Error("Output offsets do not match bytes");
          }
          frames.push({ kind: "output", start, end, bytes: body.subarray(17) });
        } else {
          const value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
            (key, value) => {
              if (typeof value === "number" && !Number.isSafeInteger(value)) {
                throw new Error("Unsafe protocol integer");
              }
              return offsets.has(key) && typeof value === "number"
                ? BigInt(value)
                : value;
            },
          ) as Response;
          if (
            !value || typeof value !== "object" ||
            typeof value.type !== "string"
          ) throw new Error("Invalid protocol response");
          frames.push({ kind: "json", value });
        }
        this.#body = undefined;
        this.#size = 0;
        this.#headerSize = 0;
      }
      return frames;
    } catch (error) {
      this.#body = undefined;
      this.#failed = true;
      throw error;
    }
  }
  finish(): void {
    if (this.#headerSize || this.#body) {
      throw new Error("Truncated protocol frame");
    }
  }
}
