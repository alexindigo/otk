// SPDX-License-Identifier: LGPL-3.0-only
import {
  basename,
  extname,
  fromFileUrl,
  isAbsolute,
  resolve,
} from "@std/path/posix";
import { encodeBase64 } from "@std/encoding/base64";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { fileLanguage } from "@otk/content";
import { HarnessError } from "@otk/harness";
import {
  type FileFact,
  type FilePreview,
  MAX_PATH_CHARS,
  MAX_PREVIEW_IMAGE_BYTES,
  MAX_PREVIEW_TEXT_BYTES,
  MAX_STAT_PATHS,
  OperationFailure,
} from "@otk/protocol";

const CONTROL = /\p{Cc}/u;
// Existence is not permission to disclose. Check both aliases and targets.
const CREDENTIALS =
  /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|\.local\/share\/keyrings|\.config\/(?:op|gh))(?:\/|$)|(?:^|\/)(?:\.envrc|\.env(?:\..*)?|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx|kdbx))(?:\/|$)/i;
const IMAGE_EXTENSION = /^\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const SNIFF_BYTES = 1024;
const STAT_MS = 1000;

function validate(path: string) {
  if (!path || path.length > MAX_PATH_CHARS || CONTROL.test(path)) {
    throw new HarnessError("params", "Invalid local file path");
  }
}

function lexicalPath(path: string, home: string, directory: string) {
  if (path.startsWith("~")) {
    if (!isAbsolute(home) || (path !== "~" && !path.startsWith("~/"))) return;
    return resolve(home, "." + path.slice(1));
  }
  if (/^file:/i.test(path)) {
    if (!/^file:\/\/(?:localhost)?\/(?!\/)/i.test(path)) return;
    try {
      const url = new URL(path);
      if (url.hostname || url.search || url.hash) return;
      const decoded = fromFileUrl(url);
      if (CONTROL.test(decoded) || decoded.startsWith("//")) return;
      return resolve(decoded);
    } catch {
      return;
    }
  }
  if (path.startsWith("//") || /^[a-z][a-z0-9+.\-]*:/i.test(path)) return;
  if (isAbsolute(path)) return resolve(path);
  if (isAbsolute(directory)) return resolve(directory, path);
}

const inside = (path: string, root: string) =>
  path === root || path.startsWith(root === "/" ? root : root + "/");
const realPath = (path: string) => Deno.realPath(path).catch(() => undefined);
type Scope = { roots: readonly string[]; deny: readonly string[] };
type Target = { lexical: string; real: string; info: Deno.FileInfo };
const permitted = (path: string, scope: Scope) =>
  !CONTROL.test(path) &&
  !CREDENTIALS.test(path) && !scope.deny.some((root) => inside(path, root));
const contained = (path: string, scope: Scope) =>
  permitted(path, scope) &&
  scope.roots.some((root) => inside(path, root));

/** Approve the opened object before reading bytes, not just the requested name. */
async function read(
  target: Target,
  scope: Scope,
  limit: number,
  signal: AbortSignal | undefined,
  once = false,
) {
  signal?.throwIfAborted();
  const handle = await open(
    target.real,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() || info.dev !== target.info.dev ||
      info.ino !== target.info.ino
    ) return;
    // Deno's restricted mode forbids /proc/self/fd even with --allow-read.
    // There, recheck the canonical name and its identity while holding the fd.
    let opened: string | undefined;
    try {
      if (Deno.build.os === "linux") {
        opened = await Deno.realPath(`/proc/self/fd/${handle.fd}`);
      }
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotCapable)) return;
    }
    if (!opened) {
      const named = await Deno.lstat(target.real);
      if (!named.isFile || named.dev !== info.dev || named.ino !== info.ino) {
        return;
      }
      opened = await realPath(target.real);
    }
    if (opened !== target.real || !contained(opened, scope)) return;
    signal?.throwIfAborted();
    return {
      bytes: await boundedBytes(handle, limit, signal, once),
      size: info.size,
    };
  } finally {
    await handle.close();
  }
}

async function boundedBytes(
  handle: FileHandle,
  limit: number,
  signal?: AbortSignal,
  once = false,
) {
  const bytes = new Uint8Array(limit);
  let offset = 0;
  while (offset < limit) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      limit - offset,
      offset,
    );
    offset += bytesRead;
    if (once || !bytesRead) break;
  }
  signal?.throwIfAborted();
  return bytes.subarray(0, offset);
}

function asText(bytes: Uint8Array, partial = false) {
  if (bytes.includes(0)) return;
  try {
    // Streaming decode discards only a valid incomplete trailing sequence.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: partial,
    });
  } catch {
    return;
  }
}

function imageMime(bytes: Uint8Array, real: string): string | undefined {
  const starts = (signature: readonly number[], offset = 0) =>
    signature.every((b, i) => bytes[i + offset] === b);
  const ascii = (signature: string, offset = 0) =>
    starts(Array.from(signature, (c) => c.charCodeAt(0)), offset);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([255, 216, 255])) return "image/jpeg";
  if (ascii("GIF87a") || ascii("GIF89a")) return "image/gif";
  if (ascii("RIFF") && ascii("WEBP", 8)) return "image/webp";
  if (ascii("BM")) return "image/bmp";
  if (starts([0, 0, 1, 0])) return "image/x-icon";
  if (ascii("ftypavif", 4) || ascii("ftypavis", 4)) return "image/avif";
  if (
    extname(real).toLowerCase() === ".svg" &&
    /<svg[\s/>]/.test(asText(bytes) ?? "")
  ) return "image/svg+xml";
}

function unavailable(): OperationFailure {
  return new OperationFailure("rejected", "file-unavailable", undefined, {
    actionLabel: "Open preview",
    reason: "The file no longer exists or is not available to OTK.",
  });
}

export class LocalFiles {
  constructor(
    private readonly options: { home: string; deny: readonly string[] },
  ) {}

  private async scope(directory: string): Promise<Scope> {
    const roots = [this.options.home, directory].filter(isAbsolute);
    const deny = this.options.deny.filter(Boolean).map((path) => resolve(path));
    const [realRoots, realDeny] = await Promise.all([
      Promise.all(roots.map(realPath)),
      Promise.all(deny.map(realPath)),
    ]);
    return {
      roots: realRoots.filter(Boolean) as string[],
      deny: [...deny, ...realDeny.filter(Boolean) as string[]],
    };
  }

  private async resolve(
    input: string,
    directory: string,
    scope: Scope,
    signal?: AbortSignal,
  ): Promise<Target | undefined> {
    const lexical = lexicalPath(input, this.options.home, directory);
    if (!lexical || !permitted(lexical, scope)) return;
    const real = await realPath(lexical);
    if (!real || !contained(real, scope)) return;
    signal?.throwIfAborted();
    const info = await Deno.stat(real);
    if (!info.isFile && !info.isDirectory) return;
    return { lexical, real, info };
  }

  async stat(
    directory: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<FileFact[]> {
    if (paths.length > MAX_STAT_PATHS) {
      throw new HarnessError("params", "Too many local file paths");
    }
    paths.forEach(validate);
    signal?.throwIfAborted();
    // Share the root lookup without letting it sit outside the path deadline.
    const scope = this.scope(directory);
    const facts: FileFact[] = [];
    for (const path of paths) {
      signal?.throwIfAborted();
      const deadline = new AbortController();
      const active = signal
        ? AbortSignal.any([signal, deadline.signal])
        : deadline.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<FileFact>((done, reject) => {
        const aborted = () =>
          signal?.aborted
            ? reject(signal.reason)
            : done({ path, status: "unknown" });
        active.addEventListener("abort", aborted, { once: true });
        timer = setTimeout(() => deadline.abort(), STAT_MS);
      });
      try {
        facts.push(
          await Promise.race([
            this.fact(directory, path, scope, active),
            timeout,
          ]),
        );
      } finally {
        clearTimeout(timer);
        deadline.abort();
      }
    }
    return facts;
  }

  private async fact(
    directory: string,
    path: string,
    roots: Promise<Scope>,
    signal: AbortSignal,
  ): Promise<FileFact> {
    try {
      const scope = await roots;
      signal.throwIfAborted();
      const target = await this.resolve(path, directory, scope, signal);
      if (!target) return { path, status: "absent" };
      const { lexical: resolved, real, info } = target;
      if (info.isDirectory) {
        return {
          path,
          status: "directory",
          resolved,
          size: 0,
          preview: "none",
        };
      }
      if (IMAGE_EXTENSION.test(extname(real))) {
        return {
          path,
          status: "file",
          resolved,
          size: info.size,
          preview: info.size <= MAX_PREVIEW_IMAGE_BYTES ? "image" : "none",
        };
      }
      const sniff = await read(target, scope, SNIFF_BYTES, signal, true);
      if (sniff) {
        return {
          path,
          status: "file",
          resolved,
          size: sniff.size,
          preview:
            asText(sniff.bytes, sniff.bytes.length < sniff.size) === undefined
              ? "none"
              : "text",
        };
      }
    } catch {
      signal.throwIfAborted();
    }
    return { path, status: "absent" };
  }

  async preview(
    directory: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FilePreview> {
    validate(path);
    signal?.throwIfAborted();
    try {
      const scope = await this.scope(directory);
      const target = await this.resolve(path, directory, scope, signal);
      if (target) {
        const { lexical: resolved, real, info } = target;
        const name = basename(resolved);
        if (info.isDirectory) {
          return { kind: "none", name, resolved, size: 0, reason: "directory" };
        }
        const image = IMAGE_EXTENSION.test(extname(real));
        const cap = image ? MAX_PREVIEW_IMAGE_BYTES : MAX_PREVIEW_TEXT_BYTES;
        if (image && info.size > cap) {
          return {
            kind: "none",
            name,
            resolved,
            size: info.size,
            reason: "too-large",
          };
        }
        const file = await read(target, scope, cap + 1, signal);
        if (file) {
          const { bytes, size } = file;
          const base = { name, resolved, size };
          if (image && (size > cap || bytes.length > cap)) {
            return { ...base, kind: "none", reason: "too-large" };
          }
          const mime = image ? imageMime(bytes, real) : undefined;
          if (mime) {
            return {
              ...base,
              kind: "image",
              mime,
              dataBase64: encodeBase64(bytes),
            };
          }
          const truncated = size > MAX_PREVIEW_TEXT_BYTES ||
            bytes.length > MAX_PREVIEW_TEXT_BYTES;
          const text = asText(
            bytes.subarray(0, MAX_PREVIEW_TEXT_BYTES),
            truncated,
          );
          if (text === undefined) {
            return { ...base, kind: "none", reason: "binary" };
          }
          return {
            ...base,
            kind: "text",
            text,
            truncated,
            lang: fileLanguage(real),
          };
        }
      }
    } catch {
      signal?.throwIfAborted();
    }
    throw unavailable();
  }
}
