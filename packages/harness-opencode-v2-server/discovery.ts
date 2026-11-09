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
  if (response.status === 401) {
    await response.body?.cancel();
    throw new HarnessError(
      "authentication",
      "Opencode authentication failed (401). Check the local service credentials.",
    );
  }
  if (
    !response.ok ||
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
  url: string,
  headers: HeadersInit = {},
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<VersionProbe> {
  const options = {
    headers,
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(5000),
    ]),
  };
  const info = await json(await fetcher(new URL("/api/info", url), options));
  if (
    typeof info?.version === "string" && Number.isSafeInteger(info.pid) &&
    Number(info.pid) > 0
  ) {
    if (!/^2\./.test(info.version)) {
      throw new HarnessError(
        "version",
        "Opencode service returned an incompatible API version",
      );
    }
    return {
      kind: "opencode-v2-server",
      version: info.version,
      pid: Number(info.pid),
    };
  }
  const health = await json(
    await fetcher(new URL("/global/health", url), options),
  );
  if (
    health?.healthy === true && typeof health.version === "string" &&
    /^1\./.test(health.version)
  ) {
    return { kind: "opencode-v1", version: health.version };
  }
  throw new HarnessError(
    "version",
    "The server speaks neither the opencode V1 nor V2 JSON API (HTML is not a health response).",
  );
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
        "No opencode service is running. Start opencode separately; OTK never starts it.",
      );
    }
    throw new HarnessError(
      "discovery",
      "Cannot read the opencode service registration.",
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
      "Malformed opencode service registration.",
    );
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new HarnessError("discovery", "Malformed opencode service URL.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username || url.password
  ) {
    throw new HarnessError(
      "discovery",
      "Opencode V2 requires a local loopback service registration.",
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
  let found: VersionProbe;
  try {
    found = await probeVersion(
      candidate.url,
      serviceHeaders(candidate),
      signal,
    );
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof HarnessError) throw cause;
    throw new HarnessError(
      "no-server",
      "The registered opencode service is unreachable. Start opencode separately; OTK never starts it.",
    );
  }
  if (found.kind !== "opencode-v2-server") {
    throw new HarnessError(
      "version",
      `Registered service is V1 (${found.version}); use harness.type="opencode-v1".`,
    );
  }
  if (
    found.pid !== record.pid ||
    (record.version !== undefined && record.version !== found.version)
  ) {
    throw new HarnessError(
      "discovery",
      "Stale opencode registration: the service PID or version changed.",
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
      "Opencode service registration changed during discovery; retry the connection.",
    );
  }
  return { endpoint, version: found.version, pid: found.pid };
}
