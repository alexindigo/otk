// SPDX-License-Identifier: LGPL-3.0-only
import manifest from "../packaging/opencode-pty.json" with { type: "json" };
import { dirname, fromFileUrl, join } from "@std/path";
import { encodeBase64 } from "@std/encoding/base64";

export async function digest(
  bytes: Uint8Array,
  algorithm = "SHA-256",
): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(algorithm, new Uint8Array(bytes)),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}

export async function verifyArchive(
  bytes: Uint8Array,
  integrity: string,
): Promise<void> {
  const hash = await crypto.subtle.digest("SHA-512", new Uint8Array(bytes));
  if (`sha512-${encodeBase64(hash)}` !== integrity) {
    throw new Error("opencode-pty tarball integrity mismatch");
  }
}

export function requireHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(
      "opencode-pty sha256 is not recorded; use --record explicitly",
    );
  }
}

/** Read just the regular binary entry, never extract arbitrary archive paths. */
export function binaryFromTar(tar: Uint8Array): Uint8Array {
  const text = new TextDecoder();
  let result: Uint8Array | undefined;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((v) => v === 0)) break;
    const field = (a: number, b: number) =>
      text.decode(header.subarray(a, b)).replace(/\0.*$/s, "").trim();
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join("/");
    const size = Number.parseInt(field(124, 136), 8);
    if (
      !Number.isSafeInteger(size) || size < 0 ||
      offset + 512 + size > tar.length
    ) throw new Error("Invalid opencode-pty tar entry");
    if (name === "package/bin/opencode-pty") {
      if (result || ![0, 48].includes(header[156])) {
        throw new Error("Invalid opencode-pty binary entry");
      }
      result = tar.slice(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!result) throw new Error("opencode-pty binary missing from tarball");
  return result;
}

export async function fetchBinary(
  target: string,
  record = false,
): Promise<string> {
  if (!(target in manifest.targets)) {
    throw new Error(`Unsupported opencode-pty target: ${target}`);
  }
  const entry = manifest.targets[target as keyof typeof manifest.targets];
  if (!record) requireHash(entry.sha256);
  const response = await fetch(entry.tarball, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`opencode-pty download: ${response.status}`);
  }
  const archive = new Uint8Array(await response.arrayBuffer());
  await verifyArchive(archive, entry.integrity);
  const tar = new Uint8Array(
    await new Response(
      new Blob([archive]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const bytes = binaryFromTar(tar), sha256 = await digest(bytes);
  if (record) {
    entry.sha256 = sha256;
    await Deno.writeTextFile(
      new URL("../packaging/opencode-pty.json", import.meta.url),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  } else if (entry.sha256 !== sha256) {
    throw new Error("opencode-pty binary checksum mismatch");
  }
  const dest = fromFileUrl(
    new URL(`../build/opencode-pty/${target}/opencode-pty`, import.meta.url),
  );
  await Deno.mkdir(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.${crypto.randomUUID()}.tmp`);
  try {
    await Deno.writeFile(tmp, bytes, { createNew: true, mode: 0o755 });
    await Deno.rename(tmp, dest);
  } finally {
    await Deno.remove(tmp).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
  console.info(`opencode-pty ${manifest.version} ${target} sha256=${sha256}`);
  return dest;
}

if (import.meta.main) {
  const args = Deno.args.filter((arg) => arg !== "--record");
  if (args.length !== 1) {
    throw new Error("Usage: fetch-opencode-pty.ts <target> [--record]");
  }
  await fetchBinary(args[0], Deno.args.includes("--record"));
}
