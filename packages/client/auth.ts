// SPDX-License-Identifier: LGPL-3.0-only
export interface AuthStatus {
  authenticated: boolean;
  setupRequired: boolean;
  authType: string;
}
export async function request<T>(
  base: URL,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(new URL(path, base), {
    credentials: "include",
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined
      ? undefined
      : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || result.code || `HTTP ${response.status}`);
  }
  return result;
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
