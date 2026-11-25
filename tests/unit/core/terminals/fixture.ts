// SPDX-License-Identifier: LGPL-3.0-only
import type { ProcessInfo } from "../../../../core/terminals/frames.ts";
import { terminalGroup } from "../../../../core/terminals/ownership.ts";

export function process(
  foreground: string | null = "sleep",
  dir = "/workspace",
  session = "tstv1-owner",
): ProcessInfo {
  return {
    id: 1,
    mode: "pty",
    pid: 42,
    command: ["/bin/bash", "-l"],
    cwd: dir,
    group_id: terminalGroup({ dir, session }),
    lifecycle: { status: "running" },
    output_head: 0n,
    output_tail: 0n,
    started_at: 1,
    exited_at: null,
    pty: {
      title: "Shell",
      user_title: null,
      foreground_process: foreground,
      cols: 80,
      rows: 24,
    },
  };
}
