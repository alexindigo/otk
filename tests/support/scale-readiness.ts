// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionScale } from "./session-scale.ts";
import { V2SessionScale } from "./v2-session-scale.ts";

/** HTTP health precedes native project tool initialization, as in Opencode.#ready. */
export async function scaleReadiness(native: SessionScale | V2SessionScale) {
  const receipts: { directory: string; tools: string[] }[] = [];
  for (
    const directory of new Set(native.manifest.sessions.map((s) => s.directory))
  ) {
    const tools = native instanceof V2SessionScale
      ? (await native.native.api.agent.list({ location: { directory } })).data
        .map(
          (agent) => agent.id,
        )
      : await native.request<unknown>("/experimental/tool/ids", { directory });
    if (
      !Array.isArray(tools) || !tools.length ||
      !tools.every((tool) => typeof tool === "string")
    ) {
      throw new Error(
        "Native scale tool registry returned an invalid readiness snapshot",
      );
    }
    receipts.push({ directory, tools });
  }
  return receipts;
}
