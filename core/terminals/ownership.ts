// SPDX-License-Identifier: LGPL-3.0-only
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { isAbsolute } from "@std/path";
import { isSessionID } from "@otk/protocol";
import type { ProcessInfo } from "./frames.ts";

export interface TerminalOwner {
  dir: string;
  session: string;
}
function valid(value: unknown): value is TerminalOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as TerminalOwner;
  return typeof owner.dir === "string" && isAbsolute(owner.dir) &&
    !owner.dir.includes("\0") && typeof owner.session === "string" &&
    isSessionID(owner.session);
}
export function terminalGroup(owner: TerminalOwner): string {
  if (!valid(owner)) throw new Error("Invalid terminal ownership");
  return "otk1:" + encodeBase64(new TextEncoder().encode(JSON.stringify(owner)))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function terminalOwner(group: string): TerminalOwner | undefined {
  if (!/^otk1:[A-Za-z0-9_-]+$/.test(group)) return;
  try {
    const encoded = group.slice(5).replaceAll("-", "+").replaceAll("_", "/");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
    ));
    if (valid(value) && terminalGroup(value) === group) return value;
  } catch { /* Unknown and malformed daemon groups are not OTK terminals. */ }
}
/** The daemon exposes Linux comm, not process identity or a background-job list. */
export function terminalRunning(process: ProcessInfo): boolean {
  if (process.mode !== "pty" || process.lifecycle.status !== "running") {
    return false;
  }
  const foreground = process.pty?.foreground_process?.replace(/^-/, "");
  const program = process.command[0]?.split("/").at(-1)?.replace(/^-/, "");
  if (!foreground || !program) return false;
  const shell = new TextDecoder().decode(
    new TextEncoder().encode(program).slice(0, 15),
  );
  return foreground !== shell;
}
