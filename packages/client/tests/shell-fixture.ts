// SPDX-License-Identifier: LGPL-3.0-only
import * as client from "@otk/client";
import { NavigationDefault } from "../../../core/features/navigation-default.ts";
import { SessionHierarchy } from "../../../core/index/session-hierarchy.ts";
import { ProjectIdentity } from "../../../core/index/project-identity.ts";
import type {
  ContentSession,
  IndexEntry,
  RpcMethod,
  RpcParams,
  RpcResult,
  TaskRecord,
} from "@otk/protocol";

export function shellEntry(
  id: string,
  directory = "/p",
  parentID?: string,
): IndexEntry {
  return {
    id,
    directory,
    parentID,
    title: id,
    projectID: "p",
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "idle",
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
}
export function shellInfo(id: string, directory = "/p"): ContentSession {
  return {
    id,
    directory,
    title: id,
    projectID: "p",
    archived: false,
    time: { created: 1, updated: 2 },
  };
}
export function shellTask(
  id: string,
  sessions: string[],
  directory = "/p",
): TaskRecord {
  return { id, name: id, sessions, directory, order: 0 };
}
export function shellFixture(
  ids = { selected: "selected", created: "created" },
) {
  const calls: unknown[][] = [];
  const servers = client.createState<client.SidecarsState>({
    list: ["local", "remote"].map((id) => ({
      id,
      baseUrl: "",
      label: id,
      status: "connected",
      harness: "connected",
      capabilities: [],
      connectionVersion: 1,
    })),
  });
  let reply: (
    id: string,
    method: RpcMethod,
    params: unknown,
  ) => Promise<unknown> = (_id, method, params) => {
    const p = params as Record<string, string>;
    if (method === "session.get") {
      return Promise.resolve(shellInfo(p.sessionID, "/resolved"));
    }
    if (method === "session.create") {
      return Promise.resolve(shellInfo(ids.created, p.directory));
    }
    if (method === "tasks.create") {
      return Promise.resolve(shellTask("promoted", [ids.selected], "/p"));
    }
    if (method === "history.attachments") {
      return Promise.resolve({
        items: (params as { refs: { messageID: string; partID: string }[] })
          .refs.map((ref) => ({
            ref,
            part: {
              kind: "file",
              source: "upload",
              name: ref.partID,
              mime: "text/plain",
              dataBase64: btoa(`bytes:${ref.partID}`),
            },
          })),
      });
    }
    return Promise.resolve(null);
  };
  const connections = new Map(["local", "remote"].map((id) => {
    const connection = new client.SidecarConnection("http://127.0.0.1:1502", {
      status() {},
      frame() {},
    }, { attachments: { concurrency: 4, maxrefs: 64, maxbytes: 33554432 } });
    connection.rpc.call = <M extends RpcMethod>(
      method: M,
      params: RpcParams<M>,
    ): Promise<RpcResult<M>> => {
      calls.push([id, method, params]);
      if (method === "navigation.default") {
        const hierarchy = new SessionHierarchy(),
          identity = new ProjectIdentity();
        const inbox = resources.inbox(id).state.inbox;
        const summaries = inbox.summaries ?? {};
        identity.learn(
          Object.values(summaries).flatMap((summary) =>
            (summary.scopes ?? [summary.directory]).map((directory) => ({
              ...summary,
              directory,
              sessionCount: summary.sessionCount,
              topology: summary.topology,
            }))
          ),
        );
        hierarchy.configure(identity, () => inbox.tasks, () => false);
        index.partition(id).forEach((row) => hierarchy.entry(row));
        const resolver = new NavigationDefault({
          hierarchy,
          scopes: (directory) => summaries[directory]?.scopes ?? [directory],
          entries: (directory) => index.partition(id, directory),
          status: (sessionID) =>
            client.inboxStatus(index.get(id, sessionID)!, inbox),
        });
        const core = {
          identities: (ids: readonly string[]) =>
            Promise.resolve(
              index.partition(id).filter((row) => ids.includes(row.id)),
            ),
          listSessions: (input: import("@otk/protocol").SessionListInput) =>
            Promise.resolve({
              items: index.partition(id, input.directory).filter((row) =>
                !row.parentID
              ).toSorted((a, b) => b.timeUpdated - a.timeUpdated).slice(
                0,
                input.limit,
              ),
              older: null,
              generation: "fixture",
            }),
        } as unknown as import("@otk/harness").HarnessCore;
        return resolver.resolve(
          core,
          params as { directory: string; preferred?: string },
        ) as Promise<RpcResult<M>>;
      }
      if (method === "sessions.identities") {
        return Promise.resolve(
          index.partition(id).filter((entry) =>
            (params as { ids: string[] }).ids.includes(entry.id)
          ).map(({ id, directory, parentID }) => ({ id, directory, parentID })),
        ) as Promise<RpcResult<M>>;
      }
      if (method === "sessions.list") {
        const input = params as import("@otk/protocol").SessionListInput;
        const items = index.partition(id, input.directory).filter((entry) =>
          input.parentID !== null || !entry.parentID
        ).slice(0, input.limit ?? 20);
        return Promise.resolve({
          items,
          older: null,
          load: {
            id: "fixture",
            state: "complete",
            generation: "fixture",
            revision: 1,
            scope: { kind: "project-sessions", directory: input.directory },
            boundary: { kind: "page", limit: input.limit ?? 20 },
          },
        }) as Promise<RpcResult<M>>;
      }
      return reply(id, method, params) as Promise<RpcResult<M>>;
    };
    return [id, connection] as const;
  }));
  const index = client.createIndex();
  const resources = client.createServerResources({
    index,
    sidecars: () => ({
      state: servers.state,
      subscribe: servers.subscribe,
      connection: (id) => connections.get(id)!,
      start() {},
      stop() {},
      add: () => Promise.resolve("added"),
      remove(id) {
        calls.push(["remove", id]);
      },
    }),
  });
  const session: Pick<client.ClientSession, "state" | "open"> = {
    state: {
      selection: { sidecarId: "local", sessionID: ids.selected },
      info: shellInfo(ids.selected),
      content: client.emptyContent(),
      siblings: [],
      loading: false,
      paging: false,
      exhausted: false,
      continuity: "ready",
    },
    open(target) {
      calls.push(["open", target]);
      session.state.selection = target;
    },
  };
  const current = client.createCurrentClient(
    () => session.state.selection,
    (id) => connections.get(id)!,
  );
  const entries = (id: string, rows: IndexEntry[]) =>
    resources.receive(id, { t: "index.snapshot", rev: 0, entries: rows });
  return {
    resources,
    session,
    current,
    calls,
    entries,
    servers,
    reply: (next: typeof reply) => {
      reply = next;
    },
  };
}
