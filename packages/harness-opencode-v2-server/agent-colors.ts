// SPDX-License-Identifier: LGPL-3.0-only
import type { AgentColor, CatalogAgent } from "@otk/protocol";
/** Optional transcript decoration borrows demanded catalogs; it never blocks a body page. */
export class AgentColors {
  #resources = new Map<
    string,
    {
      controller: AbortController;
      sessions: Set<string>;
      value?: Record<string, AgentColor>;
    }
  >();
  #tasks = new Set<Promise<void>>();
  constructor(
    readonly load: (
      directory: string,
      signal: AbortSignal,
    ) => Promise<readonly CatalogAgent[]>,
    readonly ready: (id: string, colors: Record<string, AgentColor>) => void,
    readonly failed: (cause: unknown) => void,
  ) {}
  peek(id: string, directory: string): Record<string, AgentColor> | undefined {
    let resource = this.#resources.get(directory);
    if (!resource) {
      resource = { controller: new AbortController(), sessions: new Set() };
      this.#resources.set(directory, resource);
      const owner = resource;
      const task = Promise.resolve().then(() =>
        this.load(directory, owner.controller.signal)
      ).then((agents) => {
        if (
          this.#resources.get(directory) !== owner ||
          owner.controller.signal.aborted
        ) return;
        const colors: Record<string, AgentColor> = Object.fromEntries(
          agents.flatMap((agent) =>
            agent.color ? [[agent.id, agent.color]] : []
          ),
        );
        owner.value = colors;
        for (const id of owner.sessions) this.ready(id, colors);
      }).catch((cause) => {
        if (!owner.controller.signal.aborted) this.failed(cause);
      }).finally(() => this.#tasks.delete(task));
      this.#tasks.add(task);
    }
    resource.sessions.add(id);
    return resource.value;
  }
  release(id?: string): void {
    for (const [directory, resource] of this.#resources) {
      if (id) resource.sessions.delete(id);
      if (!id || !resource.sessions.size) {
        this.#resources.delete(directory);
        resource.controller.abort();
      }
    }
  }
  reset(directory?: string): void {
    for (const [key, resource] of [...this.#resources]) {
      if (directory && directory !== key) continue;
      this.#resources.delete(key);
      resource.controller.abort();
      for (const id of resource.sessions) this.peek(id, key);
    }
  }
  async stop(): Promise<void> {
    this.release();
    await Promise.all(this.#tasks);
  }
}
