// SPDX-License-Identifier: LGPL-3.0-only
import {
  basename,
  extname,
  fromFileUrl,
  isAbsolute,
  relative,
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
  type InlineImageFact,
  type InlineImageReason,
  MAX_PATH_CHARS,
  MAX_PREVIEW_IMAGE_BYTES,
  MAX_PREVIEW_TEXT_BYTES,
  MAX_STAT_PATHS,
  OperationFailure,
} from "@otk/protocol";
import type { ImageRoots } from "./image-roots.ts";
import {
  mightBeSvg,
  rasterSize,
  rasterType,
  svgSize,
} from "./image-headers.ts";

const CONTROL = /\p{Cc}/u;
// Existence is not permission to disclose. Check both aliases and targets.
const CREDENTIALS =
  /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|\.local\/share\/keyrings|\.config\/(?:op|gh))(?:\/|$)|(?:^|\/)(?:\.envrc|\.env(?:\..*)?|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx|kdbx))(?:\/|$)/i;
const IMAGE_EXTENSION = /^\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const SNIFF_BYTES = 1024;
const STAT_MS = 1000;
const HEADER_BYTES = 256 * 1024;
export type ImageLimits = { maxbytes: number; maxpixels: number };
type ImageGood = Extract<InlineImageFact, { status: "image" }>;
type ImageUnavailable = Extract<InlineImageFact, { status: "unavailable" }>;

export function validateLocalPath(path: string) {
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
const longestRoot = (path: string, roots: readonly string[]) =>
  roots.reduce<string | undefined>(
    (longest, root) =>
      inside(path, root) && root.length > (longest?.length ?? 0)
        ? root
        : longest,
    undefined,
  );
const hidden = (path: string, root: string) =>
  relative(root, path).split("/").some((segment) => segment.startsWith("."));
const realPath = (path: string) => Deno.realPath(path).catch(() => undefined);
type Scope = { roots: readonly string[]; deny: readonly string[] };
type Target = { lexical: string; real: string; info: Deno.FileInfo };
const permitted = (path: string, scope: Scope) =>
  !CONTROL.test(path) &&
  !CREDENTIALS.test(path) && !scope.deny.some((root) => inside(path, root));
const contained = (path: string, scope: Scope) =>
  permitted(path, scope) &&
  scope.roots.some((root) => inside(path, root));

async function withinFactDeadline<T>(
  path: string,
  signal: AbortSignal | undefined,
  readFact: (active: AbortSignal) => Promise<T>,
): Promise<T | { path: string; status: "unknown" }> {
  const deadline = new AbortController();
  const active = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  active.throwIfAborted();
  const timeout = new Promise<{ path: string; status: "unknown" }>(
    (resolve, reject) => {
      active.addEventListener("abort", () => {
        if (signal?.aborted) reject(signal.reason);
        else resolve({ path, status: "unknown" });
      }, { once: true });
    },
  );
  const timer = setTimeout(() => deadline.abort(), STAT_MS);
  try {
    return await Promise.race([readFact(active), timeout]);
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}

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
      witness: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`,
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
    private readonly options: {
      home: string;
      deny: readonly string[];
      roots: Pick<ImageRoots, "roots">;
    },
  ) {}

  // Link discovery is not authority to serve a preview.
  private async factScope(directory: string): Promise<Scope> {
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
    paths.forEach(validateLocalPath);
    signal?.throwIfAborted();
    // Share the root lookup without letting it sit outside the path deadline.
    const scope = this.factScope(directory);
    const facts: FileFact[] = [];
    for (const path of paths) {
      signal?.throwIfAborted();
      facts.push(
        await withinFactDeadline(
          path,
          signal,
          (active) => this.fact(directory, path, scope, active),
        ),
      );
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

  /** The shared lexical and canonical boundary for serving local files. */
  async #allowedTarget(
    roots: readonly string[],
    directory: string,
    path: string,
    hideDotfiles: boolean,
    signal?: AbortSignal,
  ): Promise<
    { target: Target; scope: Scope } | "outside" | "denied" | "missing"
  > {
    const lexical = lexicalPath(path, this.options.home, directory);
    const lexicalRoot = lexical && longestRoot(lexical, roots);
    // Don't probe an unapproved name, even to see whether it exists.
    if (!lexical || !lexicalRoot) return "outside";
    const lexicalDeny = this.options.deny.filter(Boolean).map((value) =>
      resolve(value)
    );
    if (
      (hideDotfiles && hidden(lexical, lexicalRoot)) ||
      !permitted(lexical, { deny: lexicalDeny, roots })
    ) return "denied";

    signal?.throwIfAborted();
    const real = await realPath(lexical);
    if (!real) return "missing";
    const canonicalRoots = (await Promise.all(roots.map(realPath))).filter((
      value,
    ) => value !== undefined);
    const root = longestRoot(real, canonicalRoots);
    if (!root) return "outside";
    const deny = [
      ...lexicalDeny,
      ...(await Promise.all(lexicalDeny.map(realPath))).filter((value) =>
        value !== undefined
      ),
    ];
    const scope = { roots: canonicalRoots, deny };
    if ((hideDotfiles && hidden(real, root)) || !permitted(real, scope)) {
      return "denied";
    }
    signal?.throwIfAborted();
    const info = await Deno.stat(real);
    if (!info.isFile && !info.isDirectory) return "missing";
    return { target: { lexical, real, info }, scope };
  }

  async imageFacts(
    directory: string,
    paths: readonly string[],
    limits: ImageLimits,
    signal?: AbortSignal,
  ): Promise<InlineImageFact[]> {
    if (paths.length > MAX_STAT_PATHS) {
      throw new HarnessError("params", "Too many local file paths");
    }
    paths.forEach(validateLocalPath);
    const roots = this.options.roots.roots(directory);
    const output: InlineImageFact[] = [];
    for (const path of paths) {
      signal?.throwIfAborted();
      output.push(
        await withinFactDeadline(
          path,
          signal,
          async (active) =>
            (await this.#imageRead(
              roots,
              directory,
              path,
              limits,
              false,
              active,
            ))
              .fact,
        ),
      );
    }
    return output;
  }

  async imageBytes(
    directory: string,
    path: string,
    limits: ImageLimits,
    signal?: AbortSignal,
  ): Promise<
    { fact: ImageGood; bytes: Uint8Array<ArrayBuffer>; etag: string } | {
      fact: ImageUnavailable;
    }
  > {
    validateLocalPath(path);
    const result = await this.#imageRead(
      this.options.roots.roots(directory),
      directory,
      path,
      limits,
      true,
      signal,
    );
    if (!("bytes" in result)) return result;
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(result.witness),
    );
    const value = Array.from(
      new Uint8Array(hash, 0, 16),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return { fact: result.fact, bytes: result.bytes, etag: `"${value}"` };
  }

  async #imageRead(
    roots: readonly string[],
    directory: string,
    path: string,
    limits: ImageLimits,
    complete: boolean,
    signal?: AbortSignal,
  ): Promise<
    { fact: ImageGood; bytes: Uint8Array<ArrayBuffer>; witness: string } | {
      fact: ImageUnavailable;
    }
  > {
    // Existence is disclosed only inside allowed roots.
    const unavailable = (
      reason: InlineImageReason,
      extra?: Pick<ImageUnavailable, "size" | "limit" | "width" | "height">,
    ) => ({ fact: { path, status: "unavailable" as const, reason, ...extra } });
    try {
      const allowed = await this.#allowedTarget(
        roots,
        directory,
        path,
        true,
        signal,
      );
      if (typeof allowed === "string") return unavailable(allowed);
      const { target, scope } = allowed;
      const { lexical: resolved, info } = target;
      if (!info.isFile) return unavailable("missing");
      const tooLarge = (size: number) =>
        unavailable("too-large", { size, limit: limits.maxbytes });
      if (info.size > limits.maxbytes) return tooLarge(info.size);
      const cap = Math.min(limits.maxbytes + 1, info.size + 1);
      const header = Math.min(cap, HEADER_BYTES);
      let opened = await read(target, scope, complete ? cap : header, signal);
      if (!opened) return unavailable("missing");
      if (
        opened.size > limits.maxbytes || opened.bytes.length > limits.maxbytes
      ) return tooLarge(Math.max(opened.bytes.length, opened.size));
      if (opened.size !== info.size) return unavailable("missing");
      let type = rasterType(opened.bytes);
      let size: [number, number] | undefined;
      if (type) {
        size = rasterSize(opened.bytes.subarray(0, HEADER_BYTES), type);
      } else {
        if (
          opened.bytes.length < opened.size && !complete &&
          mightBeSvg(asText(opened.bytes, true) ?? "not svg")
        ) {
          opened = await read(target, scope, cap, signal);
          if (!opened) return unavailable("missing");
          if (
            opened.size > limits.maxbytes ||
            opened.bytes.length > limits.maxbytes
          ) return tooLarge(Math.max(opened.bytes.length, opened.size));
        }
        if (opened.bytes.length !== opened.size) {
          return unavailable("not-image");
        }
        size = svgSize(asText(opened.bytes) ?? "");
        if (size) type = "image/svg+xml";
      }
      if (
        !type || !size ||
        size.some((value) => !Number.isFinite(value) || value <= 0)
      ) return unavailable("not-image");
      const [width, height] = size;
      if (width * height > limits.maxpixels) {
        return unavailable("too-many-pixels", {
          width,
          height,
          limit: limits.maxpixels,
        });
      }
      if (complete && opened.bytes.length !== opened.size) {
        return unavailable("missing");
      }
      return {
        fact: {
          path,
          status: "image",
          resolved,
          name: basename(resolved),
          mime: type,
          width,
          height,
          size: opened.size,
        },
        bytes: opened.bytes,
        witness: opened.witness,
      };
    } catch {
      signal?.throwIfAborted();
      return unavailable("missing");
    }
  }

  async preview(
    directory: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FilePreview> {
    validateLocalPath(path);
    signal?.throwIfAborted();
    try {
      const allowed = await this.#allowedTarget(
        this.options.roots.roots(directory),
        directory,
        path,
        false,
        signal,
      );
      if (allowed === "outside") {
        return { kind: "unavailable", reason: allowed };
      }
      if (typeof allowed !== "string") {
        const { target, scope } = allowed;
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
