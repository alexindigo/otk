// SPDX-License-Identifier: LGPL-3.0-only
import { isAbsolute, join } from "@std/path";

export function daemonEnvironment(
  source: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) =>
      /^(HOME|PATH|USER|LOGNAME|LANG|LC_.*|XDG_RUNTIME_DIR|XDG_STATE_HOME|XDG_DATA_HOME)$/
        .test(key)
    ),
  );
}
export function shellEnvironment(
  source: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([key]) =>
        !key.startsWith("OTK_") &&
        !["INVOCATION_ID", "JOURNAL_STREAM", "NOTIFY_SOCKET"].includes(key)
      ),
    ),
    OTK_TERMINAL: "1",
  };
}
export function terminalDataDirectory(
  source: Readonly<Record<string, string>>,
): string {
  const root = source.XDG_DATA_HOME ||
    (source.HOME ? join(source.HOME, ".local", "share") : "");
  if (!isAbsolute(root)) {
    throw new Error("Terminal data directory must be absolute");
  }
  return join(root, "otk");
}
export async function shellProgram(
  source: Readonly<Record<string, string>>,
): Promise<string> {
  if (source.SHELL) return source.SHELL;
  if (source.USER) {
    const child = new Deno.Command("getent", {
      args: ["passwd", source.USER],
      clearEnv: true,
      env: daemonEnvironment(source),
      signal: AbortSignal.timeout(5000),
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    });
    try {
      const result = await child.output();
      const shell =
        new TextDecoder().decode(result.stdout).trim().split(":")[6];
      if (result.success && shell && isAbsolute(shell)) return shell;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return "/bin/sh";
}
export async function hasSystemd(
  source: Readonly<Record<string, string>>,
): Promise<boolean> {
  if (!source.INVOCATION_ID) return false;
  for (const path of (source.PATH ?? "").split(":")) {
    if (!isAbsolute(path)) continue;
    try {
      const stat = await Deno.stat(join(path, "systemd-run"));
      if (stat.isFile && ((stat.mode ?? 0) & 0o111)) return true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return false;
}
