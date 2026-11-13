// SPDX-License-Identifier: LGPL-3.0-only
import type { OperationContext } from "@otk/protocol";
import type { OpenCodeClient, V2Client } from "./client.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { interrupt } from "./interrupt.ts";
import type { V2Event } from "./stream.ts";

type Location = { directory: string; workspaceID?: string };
type Info = Awaited<
  ReturnType<OpenCodeClient["shell"]["list"]>
>["data"][number];
export interface RunningShell {
  id: string;
  sessionID: string;
  location: Location;
  started: number;
}
/** Scalar activity, independent of transcript demand and session executions. */
export class V2Shells {
  #running = new Map<string, RunningShell>();
  sessions(): string[] {
    return [
      ...new Set([...this.#running.values()].map((shell) => shell.sessionID)),
    ];
  }
  busy(sessionID: string): boolean {
    return [...this.#running.values()].some((shell) =>
      shell.sessionID === sessionID
    );
  }
  keys(sessionID: string): string[] {
    return [...this.#running.values()].filter((shell) =>
      shell.sessionID === sessionID
    ).map((shell) => shell.id);
  }
  clear(): void {
    this.#running.clear();
  }
  retire(sessionID: string): void {
    for (const [id, shell] of this.#running) {
      if (shell.sessionID === sessionID) this.#running.delete(id);
    }
  }
  async snapshot(
    client: V2Client,
    locations: readonly Location[],
    signal: AbortSignal,
  ): Promise<RunningShell[]> {
    const rows: RunningShell[] = [];
    for (const location of locations) {
      const result = await client.read(
        (api) => api.shell.list({ location }, { signal }),
        signal,
      );
      for (const info of result.data) {
        const shell = this.#map(info, location);
        if (shell) rows.push(shell);
      }
    }
    return rows;
  }
  replace(rows: readonly RunningShell[]): void {
    this.#running = new Map(rows.map((shell) => [shell.id, shell]));
  }
  #map(info: Info, location: Location): RunningShell | undefined {
    const sessionID = info.metadata.sessionID;
    if (
      typeof sessionID !== "string" || sessionID === "global" ||
      info.status !== "running"
    ) return;
    return { id: info.id, sessionID, location, started: info.time.started };
  }
  event(event: V2Event): { sessionID: string; ended?: number } | undefined {
    const info = event.type === "shell.created"
      ? event.data.info
      : event.data.shell;
    if (
      (event.type === "shell.created" ||
        event.type === "session.shell.started") &&
      info && typeof info === "object"
    ) {
      const raw = info as Info;
      if (!event.location || !raw.metadata || !raw.time) return;
      const shell = this.#map(raw, event.location);
      if (!shell || this.#running.has(shell.id)) return;
      this.#running.set(shell.id, shell);
      return { sessionID: shell.sessionID };
    }
    if (
      !["shell.exited", "shell.deleted", "session.shell.ended"].includes(
        event.type,
      )
    ) return;
    const id =
      event.type === "session.shell.ended" && info && typeof info === "object"
        ? Reflect.get(info, "id")
        : event.data.id;
    if (typeof id !== "string") return;
    const shell = this.#running.get(id);
    const sessionID = shell?.sessionID ??
      (event.type === "session.shell.ended" &&
          typeof event.data.sessionID === "string"
        ? event.data.sessionID
        : undefined);
    // A session-scoped terminal is positive evidence in its own right. A lost
    // start (including bootstrap/reconnect) must not discard that endpoint.
    if (!sessionID || sessionID === "global") return;
    this.#running.delete(id);
    return { sessionID, ended: event.created };
  }
  /** Discover every asking session's shell before mutating; never stop another session's work. */
  async interrupt(
    client: V2Client,
    id: string,
    operation?: OperationContext,
  ): Promise<void> {
    const sessionID = ids.decode(id);
    const session = await client.read(
      (api) => api.session.get({ sessionID }),
      operation?.signal,
    );
    const locations = new Map<string, Location>([[
      session.location.directory,
      session.location,
    ]]);
    for (const shell of this.#running.values()) {
      if (shell.sessionID === sessionID) {
        locations.set(shell.location.directory, shell.location);
      }
    }
    const rows = await this.snapshot(
      client,
      [...locations.values()],
      operation?.signal ?? client.signal,
    );
    await interrupt(client, id, operation);
    for (const shell of rows) {
      if (shell.sessionID !== sessionID) continue;
      await client.effect(
        (api) => api.shell.remove({ id: shell.id, location: shell.location }),
        operation,
        ["ShellNotFoundError"],
      );
    }
  }
}
