// SPDX-License-Identifier: LGPL-3.0-only
import * as client from "@otk/client";
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
export function shellFixture() {
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
      return Promise.resolve(shellInfo("created", p.directory));
    }
    if (method === "tasks.create") {
      return Promise.resolve(shellTask("promoted", ["selected"], "/p"));
    }
    if (method === "history.attachment") {
      return Promise.resolve({ kind: "text", text: `bytes:${p.partID}` });
    }
    return Promise.resolve(null);
  };
  const connections = new Map(["local", "remote"].map((id) => {
    const connection = new client.SidecarConnection("http://127.0.0.1:1502", {
      status() {},
      frame() {},
    });
    connection.rpc.call = <M extends RpcMethod>(
      method: M,
      params: RpcParams<M>,
    ): Promise<RpcResult<M>> => {
      calls.push([id, method, params]);
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
      selection: { sidecarId: "local", sessionID: "selected" },
      info: shellInfo("selected"),
      content: client.emptyContent(),
      siblings: [],
      loading: false,
      paging: false,
      exhausted: false,
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
    index.receive(id, { t: "index.snapshot", rev: 0, entries: rows });
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
