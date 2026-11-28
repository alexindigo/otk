// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError, ReadAdmission } from "@otk/harness";
import type { InlineImageReason } from "@otk/protocol";
import { allowedOrigin } from "../auth/middleware.ts";
import type { ServiceConfig } from "../config/schema.ts";
import { sessionID } from "../ws/params.ts";
import {
  type ImageLimits,
  type LocalFiles,
  validateLocalPath,
} from "./local-files.ts";

const ERROR_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const IMAGE_STATUS: Record<InlineImageReason, number> = {
  outside: 403,
  denied: 403,
  missing: 404,
  "not-image": 415,
  "too-large": 413,
  "too-many-pixels": 413,
};

function rejection(status: number, code: string) {
  if (status === 404) {
    return new Response("Not found", { status, headers: ERROR_HEADERS });
  }
  return Response.json({ code }, { status, headers: ERROR_HEADERS });
}

export class InlineImages {
  readonly #reads: ReadAdmission;

  constructor(
    private readonly options: {
      files: Pick<LocalFiles, "imageFacts" | "imageBytes">;
      limits: ImageLimits;
      concurrency: number;
      directory(sessionID: string, signal: AbortSignal): Promise<string>;
    },
  ) {
    // All image GETs use the same lane/priority: the existing admission queue
    // is FIFO in that case, and removes requests when their signal aborts.
    this.#reads = new ReadAdmission(undefined, options.concurrency);
  }

  async facts(
    directory: Promise<string> | string,
    paths: readonly string[],
    signal?: AbortSignal,
  ) {
    return await this.options.files.imageFacts(
      await directory,
      paths,
      this.options.limits,
      signal,
    );
  }

  async response(
    request: Request,
    cfg: Pick<ServiceConfig, "server">,
    signal = request.signal,
  ): Promise<Response> {
    if (request.method !== "GET") return rejection(405, "method");
    if (
      (request.headers.has("origin") ||
        request.headers.get("sec-fetch-site") === "cross-site") &&
      !allowedOrigin(request, cfg)
    ) {
      return rejection(403, "origin");
    }
    const query = new URL(request.url).searchParams;
    let id: string;
    const path = query.get("path");
    try {
      if (
        query.size !== 2 || query.getAll("session").length !== 1 ||
        path === null
      ) return rejection(400, "params");
      id = sessionID({ session: query.get("session") }, "session")!;
      validateLocalPath(path);
    } catch {
      return rejection(400, "params");
    }
    let directory: string;
    try {
      directory = await this.options.directory(id, signal);
    } catch (error) {
      signal.throwIfAborted();
      return error instanceof HarnessError && error.code === "session"
        ? rejection(404, "session")
        : rejection(503, "image-unavailable");
    }
    const release = await this.#reads.acquire(signal, true);
    try {
      const image = await this.options.files.imageBytes(
        directory,
        path,
        this.options.limits,
        signal,
      );
      if (!("bytes" in image)) {
        return rejection(
          IMAGE_STATUS[image.fact.reason],
          "image-" + image.fact.reason,
        );
      }
      const { bytes, etag, fact } = image;
      const filename = encodeURIComponent(fact.name).replace(
        /[!'()*]/g,
        (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
      );
      const headers = {
        ...ERROR_HEADERS,
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "Cache-Control": "private, no-cache",
        "Content-Type": fact.mime,
        "Content-Disposition": "inline; filename*=UTF-8''" + filename,
        ETag: etag,
      };
      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(bytes, {
        headers: { ...headers, "Content-Length": String(bytes.byteLength) },
      });
    } catch {
      signal.throwIfAborted();
      return rejection(503, "image-unavailable");
    } finally {
      release();
    }
  }
}
