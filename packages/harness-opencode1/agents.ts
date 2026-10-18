// SPDX-License-Identifier: LGPL-3.0-only
import type { AgentsCapability } from "@otk/harness";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
interface Agent {
  name: string;
  description?: string;
  mode: string;
  hidden?: boolean;
  color?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
}
export function agents(client: Client, directory: Directory): AgentsCapability {
  return {
    async listAgents(sessionID, primary = false) {
      const agents = await client.json<Agent[]>("/agent", {
        query: { directory: await directory.resolve(sessionID) },
      });
      return agents.filter((agent) =>
        !agent.hidden &&
        (primary ? agent.mode !== "subagent" : agent.mode !== "primary")
      )
        .map(({ name, description, color, model, variant }) => ({
          name,
          description,
          color: agentColor(color),
          model: model
            ? { provider: model.providerID, model: model.modelID }
            : undefined,
          variant,
        }));
    },
  };
}
function agentColor(color?: string): string | undefined {
  return color && /^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(color)
    ? color
    : color === "primary"
    ? "var(--accent)"
    : color === "secondary"
    ? "var(--secondary)"
    : undefined;
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
    const color = agentColor(agent.color);
    return color ? [[agent.name, color]] : [];
  }));
}

/** Directory configuration is shared across transcript pages and live events. */
export class AgentColors {
  #directories = new Map<string | undefined, Promise<Map<string, string>>>();
  constructor(readonly client: Client) {}
  get(directory?: string): Promise<Map<string, string>> {
    let colors = this.#directories.get(directory);
    if (!colors) {
      colors = agentColors(this.client, directory).catch((error) => {
        if (this.#directories.get(directory) === colors) {
          this.#directories.delete(directory);
        }
        throw error;
      });
      this.#directories.set(directory, colors);
    }
    return colors;
  }
  clear(): void {
    this.#directories.clear();
  }
}
