// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { loadServiceConfig } from "../../../sidecar/config/loader.ts";
import { Opencode1Adapter } from "../adapter.ts";
import { StreamBuffers } from "@otk/content";
import type { Session } from "../types.ts";
import type { ContentOp } from "@otk/protocol";

async function wait(read: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!read()) {
    assert(Date.now() < deadline, "Command lifecycle observation stalled");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const method of ["shell", "command"] as const) {
  Deno.test(`${method} admission resolves while the actual harness response is still pending`, async () => {
    const cfg = loadServiceConfig({
      defaultsPath: fromFileUrl(
        new URL("../../../defaults/otk.toml", import.meta.url),
      ),
      env: {},
    }).config;
    const root = fromFileUrl(new URL("../../../.test-state/", import.meta.url));
    await Deno.mkdir(root, { recursive: true });
    cfg.harness.db = join(await Deno.makeTempDir({ dir: root }), "missing.db");
    const session: Session = {
      id: "pending-command",
      projectID: "project",
      directory: "/project",
      title: "Pending command",
      time: { created: Date.now(), updated: Date.now() },
    };
    let ready = false, started = false, settled = false;
    let release!: (response: Response) => void;
    const fetcher: typeof fetch = (input, options) => {
      const url = new URL(String(input));
      if (url.pathname === "/global/health") {
        return Promise.resolve(Response.json({ version: "1.18.34" }));
      }
      if (url.pathname === "/experimental/session") {
        return Promise.resolve(Response.json([session]));
      }
      if (url.pathname === "/agent") {
        return Promise.resolve(
          Response.json([{ name: "build", mode: "primary" }]),
        );
      }
      if (url.pathname === "/global/event") {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
                  ),
                );
                options?.signal?.addEventListener(
                  "abort",
                  () => controller.close(),
                  { once: true },
                );
              },
            }),
          ),
        );
      }
      assertEquals(url.pathname, `/session/pending-command/${method}`);
      assertEquals(JSON.parse(String(options?.body)).command, "held command");
      started = true;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    const adapter = new Opencode1Adapter(cfg, new StreamBuffers(), fetcher);
    try {
      await adapter.core.start({
        connection: () => {},
        indexReset: () => {
          ready = true;
        },
        indexUpsert: () => {},
        indexRemove: () => {},
        content: () => {},
        resync: () => {},
      });
      const deadline = Date.now() + 2000;
      while (!ready) {
        assert(Date.now() < deadline, "Harness bootstrap stalled");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const capability = method === "shell"
        ? adapter.capabilities.shell.shell
        : adapter.capabilities.commands.command;
      const input = {
        sessionID: session.id,
        command: "held command",
        arguments: "held arguments",
      };
      const admitted = capability(input).then(() => {
        settled = true;
      });
      while (!started) {
        assert(Date.now() < deadline, "Actual command request did not start");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert(
        settled,
        `${method} admission still depends on the held command response`,
      );
      await admitted;
    } finally {
      release?.(Response.json({}));
      await adapter.core.stop();
    }
  });

  for (const outcome of ["failure", "stop"] as const) {
    Deno.test(`owned ${method} request ${outcome} normalizes session failures and releases its HTTP watcher`, async () => {
      const cfg = loadServiceConfig({
        defaultsPath: fromFileUrl(
          new URL("../../../defaults/otk.toml", import.meta.url),
        ),
        env: {},
      }).config;
      const root = fromFileUrl(
        new URL("../../../.test-state/", import.meta.url),
      );
      await Deno.mkdir(root, { recursive: true });
      cfg.harness.db = join(
        await Deno.makeTempDir({ dir: root }),
        "missing.db",
      );
      const session: Session = {
        id: "owned-command",
        projectID: "project",
        directory: "/project",
        title: "Owned command",
        time: { created: Date.now(), updated: Date.now() },
      };
      let ready = false, aborted = false, stopped = false;
      let release!: (response: Response) => void;
      let events!: ReadableStreamDefaultController<Uint8Array>;
      const fetcher: typeof fetch = (input, options) => {
        const url = new URL(String(input));
        if (url.pathname === "/global/health") {
          return Promise.resolve(Response.json({ version: "1.18.34" }));
        }
        if (url.pathname === "/experimental/session") {
          return Promise.resolve(Response.json([session]));
        }
        if (url.pathname === "/session/owned-command") {
          return Promise.resolve(Response.json(session));
        }
        if (url.pathname === "/agent") {
          return Promise.resolve(
            Response.json([{ name: "build", mode: "primary" }]),
          );
        }
        if (url.pathname === "/global/event") {
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  events = controller;
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
                    ),
                  );
                  options?.signal?.addEventListener(
                    "abort",
                    () => controller.close(),
                    { once: true },
                  );
                },
              }),
            ),
          );
        }
        assertEquals(url.pathname, `/session/owned-command/${method}`);
        const signal = options?.signal;
        assert(signal, "Long request has no owning lifecycle signal");
        return new Promise<Response>((resolve, reject) => {
          release = resolve;
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Stopped", "AbortError"));
          }, { once: true });
        });
      };
      const adapter = new Opencode1Adapter(cfg, new StreamBuffers(), fetcher);
      const ops: ContentOp[] = [];
      try {
        adapter.core.subscriptions(session.id, 1);
        await adapter.core.start({
          connection: () => {},
          indexReset: () => {
            ready = true;
          },
          indexUpsert: () => {},
          indexRemove: () => {},
          content: (_id, op) => ops.push(op),
          resync: () => {},
        });
        await wait(() => ready);
        const capability = method === "shell"
          ? adapter.capabilities.shell.shell
          : adapter.capabilities.commands.command;
        const input = {
          sessionID: session.id,
          command: "owned command",
          arguments: "owned arguments",
        };
        await capability(input);
        if (outcome === "stop") {
          assertEquals(ops, [{
            op: "session.error",
            error: undefined,
            errorState: {
              revision: 1,
              currentRequestID: "request-1",
              observations: [],
            },
          }], "Admission did not establish a clean identified request state");
          const admittedOps = structuredClone(ops);
          await adapter.core.stop();
          stopped = true;
          assert(aborted, "Adapter stop left the actual HTTP watcher alive");
          assertEquals(
            ops,
            admittedOps,
            "Stopped watcher published a stale session failure",
          );
        } else {
          release(
            Response.json({
              name: "UnknownError",
              data: { message: "Deferred shell failure" },
            }, { status: 503 }),
          );
          await wait(() =>
            ops.some((op) =>
              op.op === "session.error" && op.error === "Deferred shell failure"
            )
          );
          assertEquals(
            (await adapter.core.getSession(session.id)).error,
            "Deferred shell failure",
          );
          const send = (type: string, properties: Record<string, unknown>) =>
            events.enqueue(
              new TextEncoder().encode(
                `data: ${
                  JSON.stringify({ payload: { type, properties } })
                }\n\n`,
              ),
            );
          send("session.error", {
            sessionID: session.id,
            error: {
              name: "UnknownError",
              data: { message: "Stock stream failure" },
            },
          });
          await wait(() =>
            ops.some((op) =>
              op.op === "session.error" && op.error === "Stock stream failure"
            )
          );
          send("session.status", {
            sessionID: session.id,
            status: { type: "busy" },
          });
          await wait(() => {
            const op = ops.at(-1);
            return op?.op === "session.error" && op.error === undefined;
          });
          assertEquals(
            (await adapter.core.getSession(session.id)).error,
            undefined,
          );
        }
      } finally {
        release?.(Response.json({}));
        if (!stopped) await adapter.core.stop();
      }
    });
  }
}
