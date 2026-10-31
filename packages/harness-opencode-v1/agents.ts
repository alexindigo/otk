// SPDX-License-Identifier: LGPL-3.0-only
import type { AgentsCapability } from "@otk/harness";
import type { AgentColor, CatalogAgent } from "@otk/protocol";
import type { DirectoryCatalogs } from "./catalogs.ts";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
export interface Agent {
  name: string;
  description?: string | null;
  mode: string;
  hidden?: boolean;
  color?: string | null;
  model?: { providerID: string; modelID: string } | null;
  variant?: string | null;
}
export function mapAgents(values: Agent[]): CatalogAgent[] {
  return values.map((
    { name, description, color, model, variant, mode, hidden },
  ) => ({
    name,
    description: description ?? undefined,
    color: agentColor(color),
    model: model
      ? { provider: model.providerID, model: model.modelID }
      : undefined,
    variant: variant ?? undefined,
    primary: !hidden && mode !== "subagent",
    mention: !hidden && mode !== "primary",
  }));
}
export function agents(
  client: Client,
  directory: Directory,
  catalogs?: DirectoryCatalogs,
): AgentsCapability {
  return {
    async listAgents(sessionID, primary = false, signal) {
      signal?.throwIfAborted();
      const query = { directory: await directory.resolve(sessionID, signal) };
      signal?.throwIfAborted();
      const values = catalogs
        ? await catalogs.get(query.directory, "agents", signal)
        : mapAgents(
          await client.json<Agent[]>("/agent", {
            query,
            signal,
          }),
        );
      return values.filter((agent) => primary ? agent.primary : agent.mention)
        .map(({ primary: _primary, mention: _mention, ...agent }) => agent);
    },
  };
}
function hexColor(color: string): color is `#${string}` {
  return /^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(color);
}
function agentColor(color?: string | null): AgentColor | undefined {
  return color && hexColor(color)
    ? color
    : color === "primary"
    ? "accent"
    : color === "secondary"
    ? "secondary"
    : undefined;
}
export async function agentColors(
  client: Client,
  directory?: string,
  signal?: AbortSignal,
): Promise<Map<string, AgentColor>> {
  const agents = await client.json<{ name: string; color?: string | null }[]>(
    "/agent",
    { query: { directory }, signal },
  );
  return new Map(agents.flatMap((agent) => {
    const color = agentColor(agent.color);
    return color ? [[agent.name, color]] : [];
  }));
}

/** Directory configuration is shared across transcript pages and live events. */
interface ColorResource {
  work: Promise<Map<string, AgentColor>>;
  controller: AbortController;
  value?: Map<string, AgentColor>;
  sessions: Map<string, object | undefined>;
  failed?: boolean;
}
function catalogColors(
  agents: readonly CatalogAgent[],
): Map<string, AgentColor> {
  return new Map(
    agents.flatMap((agent) => agent.color ? [[agent.name, agent.color]] : []),
  );
}
export class AgentColors {
  #directories = new Map<
    string | undefined,
    ColorResource
  >();
  constructor(
    readonly client: Client,
    readonly ready: (
      colors: ReadonlyMap<string, AgentColor>,
      sessions: ReadonlyMap<string, object | undefined>,
    ) => void = () => {},
    readonly scope: () => object | undefined = () => undefined,
    readonly catalogs?: DirectoryCatalogs,
  ) {}
  get(directory?: string): Promise<Map<string, AgentColor>> {
    if (this.catalogs && directory === undefined) {
      return Promise.resolve(new Map());
    }
    let resource = this.#directories.get(directory);
    if (!resource || resource.failed) {
      const controller = new AbortController();
      const current: ColorResource = {
        controller,
        sessions: resource?.sessions ?? new Map(),
        work: Promise.resolve().then(() =>
          this.catalogs && directory !== undefined
            ? this.catalogs.get(directory, "agents", controller.signal).then((
              agents,
            ) => catalogColors(agents))
            : agentColors(this.client, directory, controller.signal)
        ).then((value) => {
          if (this.#directories.get(directory) === current) {
            current.value = value;
            this.ready(value, current.sessions);
          }
          return value;
        }).catch((error) => {
          if (this.#directories.get(directory) === current) {
            current.failed = true;
            console.warn(
              `Optional agent colors for ${directory ?? "default directory"}:`,
              error,
            );
          }
          throw error;
        }),
      };
      this.#directories.set(directory, resource = current);
    }
    return resource.work;
  }
  /** Essential content reads only available decoration; the resource owns failure. */
  peek(
    directory?: string,
    sessionID?: string,
  ): ReadonlyMap<string, AgentColor> | undefined {
    if (this.catalogs && directory === undefined) return;
    void this.get(directory).catch(
      () => {/* diagnosed by the directory owner */},
    );
    const resource = this.#directories.get(directory)!;
    const shared = directory === undefined
      ? undefined
      : this.catalogs?.peek(directory, "agents");
    if (shared) resource.value = catalogColors(shared);
    if (sessionID) resource.sessions.set(sessionID, this.scope());
    return resource.value;
  }
  release(sessionID: string): void {
    for (const resource of this.#directories.values()) {
      resource.sessions.delete(sessionID);
    }
  }
  clear(): void {
    const retired = [...this.#directories.values()];
    this.#directories.clear();
    for (const resource of retired) resource.controller.abort();
  }
  /** Renew optional decoration for current subscribers after native continuity changes. */
  reset(): void {
    const demanded = [...this.#directories].map(([directory, resource]) => ({
      directory,
      sessions: [...resource.sessions.keys()],
    }));
    this.clear();
    for (const { directory, sessions } of demanded) {
      if (!sessions.length) continue;
      void this.get(directory).catch(
        () => {/* the directory resource diagnoses failure */},
      );
      const resource = this.#directories.get(directory)!;
      for (const session of sessions) {
        resource.sessions.set(session, this.scope());
      }
    }
  }
}
