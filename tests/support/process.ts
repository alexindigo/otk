// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ChildProcess,
  spawn,
  type SpawnOptions,
} from "node:child_process";
import process from "node:process";
import { bounded, resources } from "./resources.ts";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/** The group remains owned after the leader exits; never infer group lifetime from exitCode. */
export function ownedProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
) {
  const scope = resources();
  const child = spawn(command, args, { ...options, detached: true });
  let spawnError: Error | undefined;
  child.on("error", (error) => spawnError = error);
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve())
  );
  const signal = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const members = async () => {
    if (!child.pid) return false;
    const result = await new Deno.Command("/usr/bin/ps", {
      args: ["-eo", "pgid=,stat="],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
    return new TextDecoder().decode(result.stdout).split("\n").some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === child.pid && !state?.startsWith("Z");
    });
  };
  const gone = async () => {
    await closed;
    while (await members()) await pause();
  };
  const stop = scope.defer(`process group: ${command}`, async () => {
    signal("SIGTERM");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && await members()) await pause();
    if (await members()) signal("SIGKILL");
    await bounded(`reap process group ${child.pid}`, gone(), 2000);
    if (spawnError) throw spawnError;
  });
  return { child: child as ChildProcess, stop };
}
