// SPDX-License-Identifier: LGPL-3.0-only
import { dirname, isAbsolute, join } from "@std/path";
import manifest from "../../packaging/opencode-pty.json" with { type: "json" };

export function manifestForCurrentTarget(target: string = Deno.build.target) {
  if (!(target in manifest.targets)) {
    throw new Error(`Unsupported opencode-pty target: ${target}`);
  }
  const entry = manifest.targets[target as keyof typeof manifest.targets];
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error("opencode-pty manifest has no recorded sha256");
  }
  return { ...entry, version: manifest.version, protocol: manifest.protocol };
}
export function embeddedPtyBinary(target: string = Deno.build.target): URL {
  manifestForCurrentTarget(target);
  return new URL(
    `../../build/opencode-pty/${target}/opencode-pty`,
    import.meta.url,
  );
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}
async function privateDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await Deno.lstat(path);
  if (!stat.isDirectory || stat.isSymlink) {
    throw new Error("Unsafe opencode-pty directory");
  }
  await Deno.chmod(path, 0o700);
}
async function hashMatches(path: string, hash: string): Promise<boolean> {
  try {
    const stat = await Deno.lstat(path);
    if (!stat.isFile || stat.isSymlink) {
      throw new Error("Unsafe opencode-pty executable");
    }
    return await sha256Hex(await Deno.readFile(path)) === hash;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Application composition injects the environment override, never read it here. */
export async function resolvePtyBinary(
  dataDir: string,
  embedded = embeddedPtyBinary(),
  override?: string,
): Promise<string> {
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error("OTK_PTY_BIN must be absolute");
    return override;
  }
  const { version, sha256 } = manifestForCurrentTarget();
  const dir = join(
      dataDir,
      "opencode-pty",
      `${version}-${sha256.slice(0, 16)}`,
    ),
    dest = join(dir, "opencode-pty");
  await privateDirectory(dirname(dir));
  await privateDirectory(dir);
  if (await hashMatches(dest, sha256)) {
    await Deno.chmod(dest, 0o755);
    return dest;
  }
  const bytes = await Deno.readFile(embedded);
  if (await sha256Hex(bytes) !== sha256) {
    throw new Error("Embedded opencode-pty checksum mismatch");
  }
  const tmp = `${dest}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeFile(tmp, bytes, { mode: 0o755, createNew: true });
    await Deno.rename(tmp, dest);
  } finally {
    await Deno.remove(tmp).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
  return dest;
}
