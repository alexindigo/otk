// SPDX-License-Identifier: LGPL-3.0-only
import { HttpRequests } from "./http-requests.ts";
import type { ClientRequestPolicy, RequestWindow } from "@otk/protocol";
import type { RequestMetadata } from "@otk/protocol";
export const bootstrapRequestMetadata: Readonly<
  Record<string, RequestMetadata>
> = {
  "bootstrap.session": { kind: "read", pending: "Connecting" },
  "bootstrap.health": { kind: "read", pending: "Checking server" },
  "bootstrap.login": { kind: "mutation", pending: "Signing in" },
  "bootstrap.setup": { kind: "mutation", pending: "Configuring server" },
  "bootstrap.logout": { kind: "mutation", pending: "Signing out" },
};
export interface AuthStatus {
  authenticated: boolean;
  setupRequired: boolean;
  authType: string;
  principal: string;
  requests: { window: RequestWindow; policy: ClientRequestPolicy };
  defaults?: import("./public-defaults.ts").PublicDefaults;
}
export async function request<T>(
  base: URL,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const http = new HttpRequests({
    base,
    kind: (method) => bootstrapRequestMetadata[method]?.kind ?? "mutation",
  });
  try {
    return await http.start<T>(path, body, { signal }).result;
  } finally {
    await http.stop();
  }
}
export function normalizeBase(value: string): string {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) || url.username ||
    url.password || url.search || url.hash
  ) {
    throw new Error(
      "Use an HTTP(S) base URL without credentials, query or fragment.",
    );
  }
  return url.href.replace(/\/+$/, "");
}
export function apiBase(baseUrl: string, assetUrl?: string): URL {
  // Resolve from the shipped assets/ entry to retain reverse-proxy prefixes,
  // including when the SPA is opened at /login or another fallback route.
  const relative = "../api/";
  return baseUrl
    ? new URL(baseUrl + "/api/")
    : new URL(relative, assetUrl ?? import.meta.url);
}
