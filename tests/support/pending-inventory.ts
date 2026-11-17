// SPDX-License-Identifier: LGPL-3.0-only
import { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import { type HarnessSink, SessionIndex } from "@otk/harness";
import { cfg } from "./config.ts";
import { resources } from "./resources.ts";
import { waitFor } from "./opencode.ts";

/** Native inventory transport through the real adapter, without a shadow activity map. */
export async function pendingInventoryFixture(root: string) {
  const directory = root + "/project", dropped = root + "/dropped";
  await Deno.mkdir(directory, { recursive: true });
  await Deno.mkdir(dropped, { recursive: true });
  const control = {
    failure: "" as "" | "permission" | "form",
    empty: new Set<"permission" | "form">(),
    locations: [directory, dropped],
    metadataFailure: false,
  };
  const sessions = [
    ["ses_permission", directory, "Permission inventory"],
    ["ses_form", directory, "Form inventory"],
    ["ses_dropped", dropped, "Dropped inventory"],
  ].map(([id, directory, title]) => ({
    id,
    projectID: directory,
    location: { directory },
    title,
    time: { created: 1, updated: 1 },
    slug: id,
    version: "2.2.6",
    agent: "build",
  }));
  const permission = (id: string, sessionID: string) => ({
    id,
    sessionID,
    action: "read",
    resources: ["README.md"],
    message: "Review native request",
  });
  const form = (id: string, sessionID: string) => ({
    id,
    sessionID,
    title: "Retained native form",
    fields: [{ key: "ok", type: "boolean", title: "Confirm" }],
  });
  const permissionRows = [
    permission("per_main", "ses_permission"),
    permission("per_drop", "ses_dropped"),
  ];
  const formRows = [form("frm_main", "ses_form"), form("frm_global", "global")];
  let stream!: ReadableStreamDefaultController<Uint8Array>, ready = 0;
  const reads: string[] = [], diagnostics: unknown[] = [];
  const errors: { code: string; message: string }[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url), path = url.pathname;
      reads.push(path);
      if (path === "/api/info") {
        return Response.json({
          version: "2.2.6",
          pid: 42,
        });
      }
      if (path === "/api/session/active") return Response.json({ data: {} });
      if (path === "/api/debug/location") {
        return Response.json(
          control.locations.map((directory) => ({ directory })),
        );
      }
      if (path === "/api/shell") return Response.json({ data: [] });
      const kind = path === "/api/permission/request"
        ? "permission"
        : path === "/api/form"
        ? "form"
        : undefined;
      if (kind) {
        if (control.failure === kind) {
          return Response.json({
            _tag: "Unavailable",
            message: "Inventory unavailable",
          }, { status: 503 });
        }
        const directory = decodeURIComponent(
          request.headers.get("x-opencode-directory") ??
            url.searchParams.get("location[directory]") ??
            url.searchParams.get("directory") ?? "",
        );
        const rows = kind === "permission" ? permissionRows : formRows;
        return Response.json({
          data: control.empty.has(kind)
            ? []
            : rows.filter((row) =>
              row.sessionID === "global"
                ? directory === sessions[0].location.directory
                : sessions.find((s) => s.id === row.sessionID)?.location
                  .directory === directory
            ),
        });
      }
      if (path === "/api/event") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"server.connected","data":{}}\n\n',
                ),
              );
              request.signal.addEventListener("abort", () => {
                try {
                  controller.close();
                } catch { /* Retired. */ }
              }, { once: true });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (
        sessions.some((row) => path === `/api/session/${row.id}/inbox`)
      ) return Response.json({ data: [] });
      if (path.endsWith("/message")) {
        return Response.json({
          data: [],
          cursor: {},
        });
      }
      if (path === "/api/session") {
        return Response.json({
          data: sessions,
          cursor: {},
        });
      }
      const session = sessions.find((row) => path === "/api/session/" + row.id);
      if (session) {
        return control.metadataFailure
          ? Response.json({ _tag: "Unavailable" }, { status: 503 })
          : Response.json({ data: session });
      }
      return new Response(null, { status: 404 });
    },
  );
  resources().defer("pending inventory HTTP server", () => server.shutdown());
  const serviceFile = root + "/service.json",
    settings = cfg(),
    index = new SessionIndex();
  await Deno.writeTextFile(
    serviceFile,
    JSON.stringify({
      url: `http://127.0.0.1:${server.addr.port}`,
      version: "2.2.6",
      pid: 42,
    }),
  );
  const adapter = new OpencodeV2ServerAdapter(
    { serviceFile, harness: settings.harness, messages: settings.messages },
    undefined,
    (error) => diagnostics.push(error),
  );
  const connected = adapter.stream.ports.connected;
  adapter.stream.ports.connected = (client, generation) => {
    connected(client, generation);
    ready++;
  };
  resources().defer("pending inventory adapter", () => adapter.core.stop());
  return {
    adapter,
    index,
    directory,
    dropped,
    sessions,
    control,
    reads,
    diagnostics,
    errors,
    async start(sink?: HarnessSink) {
      const target = {
        index,
        retainedSessions: sessions.map((s) => "opcv2-" + s.id),
        connection() {},
        indexReset() {},
        indexUpsert: (row: import("@otk/protocol").SessionMetadata) =>
          index.upsertMetadata(row),
        indexRemove: (id: string) => index.remove(id),
        content() {},
        invalidate() {},
        bootstrapComplete() {},
        error: (value: { code: string; message: string }) => errors.push(value),
      };
      await adapter.core.start(
        sink ?? target,
      );
    },
    async reconnect() {
      const previous = ready;
      stream.error(new Error("Fixture reconnect boundary"));
      await waitFor(() => ready, (value) => value > previous);
    },
    async settle(kind: "permission" | "form", id: string, sessionID: string) {
      const event = kind === "permission"
        ? { type: "permission.replied", data: { sessionID, requestID: id } }
        : { type: "form.cancelled", data: { sessionID, id } };
      stream.enqueue(
        new TextEncoder().encode(
          "data: " + JSON.stringify({ ...event, location: { directory } }) +
            "\n\n",
        ),
      );
      await waitFor(() => adapter.pending.settled(kind, id), Boolean);
    },
  };
}
