// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { staticFile } from "./static.ts";

/** Vite's index references content-hashed assets; identity belongs to the served bytes. */
export async function servedBuild(root: string): Promise<string> {
  const index = await staticFile(join(root, "index.html"));
  if (!index) return "unbundled";
  const hash = await crypto.subtle.digest("SHA-256", index);
  return Array.from(
    new Uint8Array(hash, 0, 8),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
