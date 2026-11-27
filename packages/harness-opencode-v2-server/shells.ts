// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import type { OperationContext } from "@otk/protocol";
import type { OpenCodeClient, V2Client } from "./client.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { interrupt } from "./interrupt.ts";
import type { V2Event } from "./stream.ts";

type Location = { directory: string; workspaceID?: string };
type Info = Awaited<
  ReturnType<OpenCodeClient["shell"]["list"]>
>["data"][number];

/** V2 parks user-shell results (including launch failures) with resume:false.
 * A model shell's background result has a job ID and wakes the runner. */
export function parkedShellResult(item: unknown): boolean {
  if (
    !item || typeof item !== "object" ||
    Reflect.get(item, "type") !== "synthetic"
  ) {
    return false;
  }
  const payload: unknown = Reflect.get(item, "payload");
  const meta: unknown = payload && typeof payload === "object"
    ? Reflect.get(payload, "metadata")
    : undefined;
  return !!meta && typeof meta === "object" &&
    Reflect.get(meta, "source") === "shell" &&
    Reflect.get(meta, "jobID") === undefined &&
    (typeof Reflect.get(meta, "shellID") === "string" ||
      Reflect.get(meta, "state") === "error");
}

export interface RunningShell {
  id: string;
  sessionID: string;
  location: Location;
  started: number;
  title?: string;
}
/** Scalar activity, independent of transcript demand and session executions. */
export class V2Shells {
  #running = new Map<string, RunningShell>();
  #bySession = new Map<string, Map<string, RunningShell>>();
  #add(shell: RunningShell): void {
    this.#running.set(shell.id, shell);
    let rows = this.#bySession.get(shell.sessionID);
    if (!rows) this.#bySession.set(shell.sessionID, rows = new Map());
    rows.set(shell.id, shell);
  }
  #remove(id: string): void {
    const shell = this.#running.get(id);
    if (!shell) return;
    this.#running.delete(id);
    const rows = this.#bySession.get(shell.sessionID)!;
    rows.delete(id);
    if (!rows.size) this.#bySession.delete(shell.sessionID);
  }
  sessions(): string[] {
    return [...this.#bySession.keys()];
  }
  busy(sessionID: string): boolean {
    return this.#bySession.has(sessionID);
  }
  keys(sessionID: string): string[] {
    return [...(this.#bySession.get(sessionID)?.keys() ?? [])];
  }
  items(sessionID: string) {
    return [...(this.#bySession.get(sessionID)?.values() ?? [])]
      .map((shell) => ({
        id: shell.id,
        kind: "shell" as const,
        label: "Shell",
        title: shell.title ?? "Shell",
        startedAt: shell.started,
      }));
  }
  clear(): void {
    this.#running.clear();
    this.#bySession.clear();
  }
  retire(sessionID: string): void {
    for (const id of this.keys(sessionID)) this.#remove(id);
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
    this.clear();
    for (const shell of rows) this.#add(shell);
  }
  #map(info: Info, location: Location): RunningShell | undefined {
    const sessionID = info.metadata.sessionID;
    if (
      typeof sessionID !== "string" || sessionID === "global" ||
      info.status !== "running"
    ) return;
    return {
      id: info.id,
      sessionID,
      location,
      started: info.time.started,
      title: typeof info.metadata.description === "string"
        ? info.metadata.description
        : info.command,
    };
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
      this.#add(shell);
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
    this.#remove(id);
    return { sessionID, ended: event.created };
  }
  /** Only a shell in the captured session's native roster can be terminated. */
  async terminate(
    client: V2Client,
    id: string,
    shellID: string,
    operation?: OperationContext,
  ): Promise<void> {
    const shell = this.#bySession.get(ids.decode(id))?.get(shellID);
    if (!shell) {
      throw new HarnessError(
        "shell",
        "That shell is not running in this session.",
      );
    }
    await this.#terminate(client, shell, operation);
    // Exit/deletion events own the roster, not the caller or its HTTP receipt.
  }
  async #terminate(
    client: V2Client,
    shell: RunningShell,
    operation?: OperationContext,
  ): Promise<void> {
    await client.effect(
      (api) => api.shell.remove({ id: shell.id, location: shell.location }),
      operation,
      ["ShellNotFoundError"],
    );
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
      await this.#terminate(client, shell, operation);
    }
  }
}
