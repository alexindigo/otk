// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";

/** Filter one bounded native directory listing using Git's own ignore authority.
 * No shell, index writes, population scan or locally reimplemented pattern rules.
 */
export async function ignoredFiles(
  directory: string,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<Set<string>> {
  const ignored = new Set<string>();
  const env: Record<string, string> = { LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  for (
    const key of [
      "PATH",
      "HOME",
      "XDG_CONFIG_HOME",
      "USERPROFILE",
      "SYSTEMROOT",
    ]
  ) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  for (let at = 0; at < paths.length; at += 128) {
    signal.throwIfAborted();
    const batch = paths.slice(at, at + 128);
    if (batch.some((path) => path.includes("\0"))) {
      throw new Error("Malformed native file path");
    }
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command("git", {
        args: ["check-ignore", "--stdin", "-z", "--no-index"],
        cwd: directory,
        env,
        clearEnv: true,
        signal,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (error) {
      signal.throwIfAborted();
      throw new HarnessError(
        "connection",
        `Git is unavailable for file catalog ignore checks: ${String(error)}`,
      );
    }
    const writer = child.stdin.getWriter();
    const output = child.output();
    const write = (async () => {
      try {
        await writer.write(new TextEncoder().encode(batch.join("\0") + "\0"));
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    })();
    const [outcome, written] = await Promise.allSettled([output, write]);
    signal.throwIfAborted();
    if (outcome.status === "rejected") throw outcome.reason;
    const result = outcome.value;
    const stderr = new TextDecoder().decode(result.stderr);
    if (result.code === 128 && stderr.includes("not a git repository")) {
      return ignored;
    }
    if (written.status === "rejected") throw written.reason;
    if (result.code !== 0 && result.code !== 1) {
      throw new HarnessError(
        "connection",
        `Git file catalog ignore check failed (${result.code}): ${stderr.trim()}`,
      );
    }
    for (const path of new TextDecoder().decode(result.stdout).split("\0")) {
      if (path) ignored.add(path);
    }
  }
  return ignored;
}
