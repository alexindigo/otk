// SPDX-License-Identifier: LGPL-3.0-only
import type { AgentsCapability } from "@otk/harness";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
export function agents(client: Client, directory: Directory): AgentsCapability {
  return {
    async listAgents(sessionID) {
      const agents = await client.json<
        { name: string; description?: string; mode: string; hidden?: boolean }[]
      >("/agent", { query: { directory: await directory.resolve(sessionID) } });
      return agents.filter((agent) => !agent.hidden && agent.mode !== "primary")
        .map(({ name, description }) => ({ name, description }));
    },
  };
}
export async function agentColors(
  client: Client,
  directory?: string,
): Promise<Map<string, string>> {
  const agents = await client.json<{ name: string; color?: string }[]>(
    "/agent",
    { query: { directory } },
  );
  return new Map(agents.flatMap((agent) => {
    const color = agent.color &&
        /^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(agent.color)
      ? agent.color
      : agent.color === "primary"
      ? "var(--accent)"
      : agent.color === "secondary"
      ? "var(--secondary)"
      : undefined;
    return color ? [[agent.name, color]] : [];
  }));
}
