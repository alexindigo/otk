// SPDX-License-Identifier: LGPL-3.0-only
import type { ServiceConfig } from "../../config/schema.ts";
import { HarnessError } from "../types.ts";
export class HttpFailure extends HarnessError {
  constructor(
    readonly status: number,
    readonly detail: { message: string; kind?: string; ref?: string },
  ) {
    super(`harness_${status}`, detail.message.slice(0, 1024));
  }
}
export class Client {
  constructor(
    readonly cfg: ServiceConfig["harness"],
    readonly fetcher: typeof fetch = fetch,
  ) {}
  url(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): URL {
    const url = new URL(this.cfg.url.replace(/\/$/, "") + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }
  async request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      signal?: AbortSignal;
      stream?: boolean;
      timeout?: number | null;
    } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (this.cfg.password) {
      headers.set(
        "Authorization",
        `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
      );
    }
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const response = await this.fetcher(this.url(path, options.query), {
      method: options.method || "GET",
      headers,
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
      signal: options.signal ??
        (options.stream || options.timeout === null
          ? undefined
          : AbortSignal.timeout(options.timeout ?? 15_000)),
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      let kind: string | undefined, ref: string | undefined;
      try {
        const value: unknown = JSON.parse(text);
        if (value && typeof value === "object" && "data" in value) {
          if ("name" in value && typeof value.name === "string") {
            kind = value.name;
          }
          const data = value.data;
          if (
            data && typeof data === "object" && "message" in data &&
            typeof data.message === "string"
          ) message = data.message;
          if (
            data && typeof data === "object" && "ref" in data &&
            typeof data.ref === "string"
          ) ref = data.ref;
        }
      } catch { /* Non-JSON errors retain the existing HTTP text. */ }
      throw new HttpFailure(response.status, {
        message,
        ...(kind ? { kind } : {}),
        ...(ref ? { ref } : {}),
      });
    }
    return response;
  }
  async json<T>(
    path: string,
    options: Parameters<Client["request"]>[1] = {},
  ): Promise<T> {
    const response = await this.request(path, options);
    return response.status === 204 ? undefined as T : await response.json();
  }
}
