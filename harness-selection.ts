// SPDX-License-Identifier: LGPL-3.0-only
import { Buffer } from "node:buffer";
import type { ServiceConfig } from "./core/mod.ts";
import {
  type DiscoveredService,
  discoverV2,
  probeVersion,
  serviceFile,
} from "@otk/harness-opencode-v2-server";
import { HarnessError } from "@otk/harness";

export type HarnessSelection =
  | { kind: "opencode-v1"; version: string }
  | { kind: "opencode-v2-server"; service: DiscoveredService; file: string };
/** Application boundary owns paths/config; no adapter reads process env. */
export async function selectHarness(
  config: ServiceConfig["harness"],
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<HarnessSelection> {
  const type = config.type === "opencode1" ? "opencode-v1" : config.type;
  let missingRegistration: string | undefined;
  if (!["auto", "opencode-v1", "opencode-v2-server"].includes(type)) {
    throw new HarnessError(
      "config",
      `harness.type (OTK_HARNESS_TYPE): unsupported backend ${type}`,
    );
  }
  if (type !== "opencode-v1") {
    const file = serviceFile(env);
    let missing = false;
    try {
      await Deno.stat(file);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) missing = true;
      else {throw new HarnessError(
          "discovery",
          `Cannot read the opencode service registration ${file}.`,
        );}
    }
    if (!missing || type === "opencode-v2-server") {
      return {
        kind: "opencode-v2-server",
        service: await discoverV2(file, signal),
        file,
      };
    }
    missingRegistration = file;
  }
  const headers: HeadersInit = config.password
    ? {
      authorization: "Basic " +
        Buffer.from(`${config.username}:${config.password}`, "utf8").toString(
          "base64",
        ),
    }
    : {};
  let probe;
  try {
    probe = await probeVersion(
      {
        url: config.url,
        source: {
          kind: config.password ? "config" : "none",
          fallback: type === "auto",
        },
        missingRegistration,
      },
      headers,
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    // An explicit backend selection is not a readiness gate. Keep V1's cached
    // metadata and reconnect lifetime available while native health is unknown.
    // A positively detected V2 mismatch still rejects below; 401 stays plain.
    if (
      type === "opencode-v1" &&
      !(error instanceof HarnessError && error.code === "authentication")
    ) {
      return { kind: "opencode-v1", version: "unknown" };
    }
    throw error;
  }
  if (probe.kind !== "opencode-v1") {
    throw new HarnessError(
      "version",
      `Detected opencode V2 (${probe.version}). Use harness.type="auto" or "opencode-v2-server" with its local service registration.`,
    );
  }
  return { kind: "opencode-v1", version: probe.version };
}
