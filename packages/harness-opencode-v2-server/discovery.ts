// SPDX-License-Identifier: LGPL-3.0-only
import { type Endpoint, Service } from "@opencode/client/service";
import { HarnessError } from "@otk/harness";

export type VersionProbe =
  | { kind: "opencode-v2-server"; version: string; pid: number }
  | { kind: "opencode-v1"; version: string };
export interface DiscoveredService {
  endpoint: Endpoint;
  version: string;
  pid: number;
}
export interface ProbeTarget {
  url: string;
  source:
    | { kind: "registration"; file: string; pid: number; version?: string }
    | { kind: "config"; fallback?: boolean }
    | { kind: "none"; fallback?: boolean };
  missingRegistration?: string;
}
export function serviceFile(env: Record<string, string | undefined>): string {
  const state = env.XDG_STATE_HOME ??
    (env.HOME ? `${env.HOME}/.local/state` : undefined);
  if (!state) {
    throw new HarnessError(
      "discovery",
      "Cannot locate opencode service registration: HOME is unset",
    );
  }
  return `${state}/opencode/service.json`;
}
export function serviceHeaders(endpoint: Endpoint): Record<string, string> {
  return Service.headers(endpoint) ?? {};
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
async function json(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  if (
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    await response.body?.cancel();
    return;
  }
  try {
    return object(await response.json());
  } catch {
    return;
  }
}
export async function probeVersion(
  target: ProbeTarget,
  headers: HeadersInit = {},
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<VersionProbe> {
  const source = target.source;
  // Absolute probe paths target the origin. Keep user-info, query and fragment
  // out of diagnostics without changing the URL used for the request.
  let displayURL = "<invalid URL>";
  try {
    displayURL = new URL(target.url).origin;
  } catch {
    /* the request below reports the invalid target without its bytes */
  }
  const provenance = source.kind === "registration"
    ? `${
      new Headers(headers).has("authorization")
        ? "credentials from"
        : "no credentials were sent;"
    } registration ${source.file}`
    : source.kind === "config"
    ? `harness.url (${displayURL}), credentials from config/env`
    : `no credentials were sent${
      source.fallback ? " (harness.url fallback)" : " (none)"
    }`;
  const failure = (code: string, detail: string) =>
    new HarnessError(
      code,
      `${
        target.missingRegistration
          ? `no opencode service registration at ${target.missingRegistration}; `
          : ""
      }Opencode at ${displayURL}: ${detail}; ${provenance}.`,
    );
  const options = {
    headers,
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(5000),
    ]),
  };
  try {
    const response = await fetcher(new URL("/api/info", target.url), options);
    const info = await json(response);
    // Identity evidence is authoritative even on an unsuccessful response. A
    // different registered owner is stale, not a password failure for this owner.
    if (
      source.kind === "registration" && (
        (Number.isSafeInteger(info?.pid) && Number(info?.pid) > 0 &&
          info?.pid !== source.pid) ||
        (source.version !== undefined && typeof info?.version === "string" &&
          info.version !== source.version)
      )
    ) {
      throw failure(
        "discovery",
        "Stale opencode registration: the service PID or version changed",
      );
    }
    if (response.status === 401) {
      throw failure(
        "authentication",
        "request rejected: authentication failed (401)",
      );
    }
    if (
      response.ok &&
      typeof info?.version === "string" && Number.isSafeInteger(info.pid) &&
      Number(info.pid) > 0
    ) {
      if (!/^2\./.test(info.version)) {
        throw failure(
          "version",
          "service returned an incompatible API version",
        );
      }
      return {
        kind: "opencode-v2-server",
        version: info.version,
        pid: Number(info.pid),
      };
    }
    const healthResponse = await fetcher(
      new URL("/global/health", target.url),
      options,
    );
    const health = await json(healthResponse);
    if (healthResponse.status === 401) {
      throw failure(
        "authentication",
        "request rejected: authentication failed (401)",
      );
    }
    if (
      healthResponse.ok &&
      health?.healthy === true && typeof health.version === "string" &&
      /^1\./.test(health.version)
    ) {
      return { kind: "opencode-v1", version: health.version };
    }
    throw failure(
      "version",
      `server speaks neither the opencode V1 nor V2 JSON API (HTML is not a health response); /api/info HTTP ${response.status}, /global/health HTTP ${healthResponse.status}`,
    );
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof HarnessError) throw cause;
    throw failure(
      "no-server",
      "service is unreachable or the probe timed out. Start opencode separately; OTK never starts it",
    );
  }
}
/** Read-only diagnostics precede discover: the SDK intentionally collapses failures. */
export async function discoverV2(
  file: string,
  signal?: AbortSignal,
): Promise<DiscoveredService> {
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) {
      throw new HarnessError(
        "no-server",
        `No opencode service is running: no opencode service registration at ${file}. Start opencode separately; OTK never starts it.`,
      );
    }
    throw new HarnessError(
      "discovery",
      `Cannot read the opencode service registration ${file}.`,
    );
  }
  let record: Record<string, unknown> | undefined;
  try {
    record = object(JSON.parse(text));
  } catch { /* classified below */ }
  if (
    !record || typeof record.url !== "string" ||
    !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 ||
    (record.password !== undefined && typeof record.password !== "string") ||
    (record.version !== undefined && typeof record.version !== "string")
  ) {
    throw new HarnessError(
      "discovery",
      `Malformed opencode service registration ${file}.`,
    );
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new HarnessError(
      "discovery",
      `Malformed opencode service URL in registration ${file}.`,
    );
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username || url.password
  ) {
    throw new HarnessError(
      "discovery",
      `Opencode V2 requires a local loopback service registration (${file}).`,
    );
  }
  const candidate: Endpoint = {
    url: record.url,
    ...(typeof record.password === "string"
      ? {
        auth: {
          type: "basic",
          username: "opencode",
          password: record.password,
        },
      }
      : {}),
  };
  const found = await probeVersion(
    {
      url: candidate.url,
      source: {
        kind: "registration",
        file,
        pid: Number(record.pid),
        ...(typeof record.version === "string"
          ? { version: record.version }
          : {}),
      },
    },
    serviceHeaders(candidate),
    signal,
  );
  if (found.kind !== "opencode-v2-server") {
    throw new HarnessError(
      "version",
      `Registered service at ${candidate.url} (registration ${file}) is V1 (${found.version}); use harness.type="opencode-v1".`,
    );
  }
  signal?.throwIfAborted();
  const endpoint = await Service.discover({ file });
  signal?.throwIfAborted();
  let current: Record<string, unknown> | undefined;
  try {
    current = object(JSON.parse(await Deno.readTextFile(file)));
  } catch {
    /* a removed or unreadable replacement cannot validate this instance */
  }
  signal?.throwIfAborted();
  if (
    !current ||
    ["id", "version", "url", "pid", "password"].some((key) =>
      current[key] !== record[key]
    ) || !endpoint || endpoint.url !== candidate.url ||
    JSON.stringify(Service.headers(endpoint)) !==
      JSON.stringify(Service.headers(candidate))
  ) {
    throw new HarnessError(
      "discovery",
      `Opencode service registration ${file} at ${candidate.url} changed during discovery; retry the connection.`,
    );
  }
  return { endpoint, version: found.version, pid: found.pid };
}
