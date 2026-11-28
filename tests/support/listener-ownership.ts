// SPDX-License-Identifier: LGPL-3.0-only
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface PortListener {
  pid: number;
  cgroup: string;
}
export interface ReleasedPort {
  port: number;
  state: "closed" | "reassigned";
  listeners: PortListener[];
}
async function listeners(port: number): Promise<PortListener[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid owned port: ${port}`);
  }
  const { stdout } = await exec("ss", [
    "--listening",
    "--tcp",
    "--numeric",
    "--processes",
    "--cgroup",
    "--no-header",
    "--oneline",
    `sport = :${port}`,
  ], { timeout: 5000 });
  const observed: PortListener[] = [];
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((match) =>
      Number(match[1])
    );
    const cgroup = line.match(/\bcgroup:(\S+)/)?.[1];
    if (!pids.length || !cgroup?.startsWith("/")) {
      throw new Error(`Unidentified listener on owned port ${port}`);
    }
    // Kernel socket ownership and process identity come from one observation;
    // don't race a later /proc read (or require Deno's protected-proc access).
    for (const pid of pids) observed.push({ pid, cgroup });
  }
  return observed;
}

/** A numeric port may be reused after its fixture exits. Prove ownership, not
 * global absence: an owned or unidentified listener still fails the audit. */
export async function releasedPort(
  port: number,
  unit: string,
  observe: (port: number) => Promise<PortListener[]> = listeners,
): Promise<ReleasedPort> {
  const current = await observe(port);
  for (const listener of current) {
    if (!listener.cgroup.trim()) {
      throw new Error(`Unidentified listener on owned port ${port}`);
    }
    if (
      listener.cgroup.split("\n").some((line) => {
        const path = line.slice(line.lastIndexOf(":") + 1);
        return path.split("/").includes(unit);
      })
    ) {
      throw new Error(
        `Owned port survived cleanup: ${port} (PID ${listener.pid})`,
      );
    }
  }
  return {
    port,
    state: current.length ? "reassigned" : "closed",
    listeners: current,
  };
}
