// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { fixture } from "./config.ts";
import { nativeFixture } from "./native-fixture.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { consumerAssets } from "./consumer-builds.ts";
import { serve } from "./http.ts";
import { WsClient } from "./ws-client.ts";
import { themeManifest } from "./theme-manifest.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { registerSessionActions } from "../../core/mod.ts";
import { OperationFailure } from "@otk/protocol";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";
/** One real native stack plus accurately labelled public external-backend scenes. */
export async function themeScenario() {
  const root = await fixture(), native = await nativeFixture();
  const session = await native.oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Native theme corpus" },
  });
  await native.oc.request(`/session/${session.id}/message`, {
    method: "POST",
    body: {
      noReply: true,
      parts: [{ type: "text", text: "Fixed native source for theme evidence" }],
    },
  });
  const sidecar = await native.sidecar();
  const nc = new WsClient(sidecar.url);
  await nc.connect();
  await nc.rpc("layout.patch", {
    rightCollapsed: false,
    rightView: "sessions",
  });
  const emptySession = await native.oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Empty native session" },
  });
  await nc.rpc("tasks.create", {
    directory: native.oc.directory,
    name: "Retained native task",
    sessions: [session.id],
  });
  const dist = await consumerAssets("theme-scenes");
  const styles = await consumerAssets("styles");
  const manifest = await themeManifest();
  const server = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/manifest.json") return Response.json(manifest);
      const base = path.startsWith("/styles/") ? styles : dist;
      const name = path.startsWith("/styles/") ? path.slice(7) : path;
      const file = join(base, name === "/" ? "index.html" : name);
      try {
        return new Response(await Deno.readFile(file), {
          headers: {
            "content-type": file.endsWith(".js")
              ? "text/javascript"
              : file.endsWith(".css")
              ? "text/css"
              : file.endsWith(".woff2")
              ? "font/woff2"
              : "text/html",
          },
        });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        return new Response("Not found", { status: 404 });
      }
    },
  );
  const scenes = `http://127.0.0.1:${server.addr.port}`;
  const f = await inboxBrowserFixture(root, [scenes], {
    "tstv1-otk": [0, 1, 2].map((i) => ({
      id: `prompt-${i}`,
      sessionID: "tstv1-otk",
      role: "user" as const,
      time: { created: 1000 + i },
      parts: [{
        id: `text-${i}`,
        kind: "text" as const,
        synthetic: false,
        blocks: [{
          b: "paragraph" as const,
          inline: [{ i: "text" as const, text: `Fixed Timeline prompt ${i}` }],
        }],
      }],
    })),
  }, await consumerAssets("panel"));
  Object.assign(f.app.backend.capabilities, {
    sessionActions: {
      rename: () =>
        Promise.reject(
          new OperationFailure(
            "rejected",
            "request.params",
            new Error("Rename refused; keep the edited title and try again."),
          ),
        ),
      remove: async () => {},
      fork: (id: string) => f.app.backend.core.getSession(id),
      compact: async () => {},
    },
  });
  registerSessionActions(f.app.connections.rpc, f.app.backend);
  const c = new WsClient(f.url);
  await c.connect();
  const base = f.entries[0];
  for (let i = 1; i < 12; i++) {
    f.add({
      ...base,
      id: `tstv1-visual-${i}`,
      title: `Session ${i} with a deliberately long name`,
    });
  }
  f.add({
    ...base,
    id: "tstv1-child",
    parentID: base.id,
    title: "Explore callers",
  });
  f.add({
    ...base,
    id: "tstv1-blocked",
    title: "Approve schema",
    attention: { ...base.attention, questions: 1 },
  });
  f.update(base.id, { status: "busy" });
  f.update("tstv1-atmosphera", {
    attention: { ...f.entries[1].attention, permissions: 1 },
  });
  f.update("tstv1-globnotes", { status: "busy" });
  f.update("tstv1-globnotes", { status: "idle" });
  f.add({
    ...base,
    id: "tstv1-working",
    title: "Work",
    status: "busy",
  });
  f.add({
    ...base,
    id: "tstv1-finished",
    title: "Done",
    status: "busy",
  });
  f.update("tstv1-finished", { status: "idle" });
  for (const entry of f.entries.slice(0, 3)) {
    await c.rpc("projects.visit", { directory: entry.directory, active: true });
  }
  await c.rpc("projects.visit", {
    directory: f.entries[3].directory,
    active: true,
  });
  await c.rpc("projects.inactive", {
    directory: f.entries[3].directory,
    inactive: true,
  });
  const discovered = join(root, "projects", "discovered");
  await Deno.mkdir(discovered);
  f.add({
    ...base,
    id: "tstv1-discovered",
    directory: discovered,
    projectID: "discovered",
    title: "Discovered project",
    status: "busy",
  });
  const baseline = await c.rpc<Record<string, Json>>("prefs.get", {});
  await Deno.mkdir(join(root, "projects", "empty"));
  await c.rpc("projects.templates", {
    templates: [join(root, "projects", "{project}")],
  });
  const overflow: { ids: string[]; tasks: string[] } = { ids: [], tasks: [] };
  let lease: TestLease | undefined;
  const info = {
    root,
    url: f.url,
    nativeUrl: native.oc.url,
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid, native.oc.process.pid!, sidecar.process.pid!],
    ports: [
      server.addr.port,
      Number(new URL(f.url).port),
      native.fake.port,
      native.oc.port,
      native.oc.nativePort,
      sidecar.port,
    ],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign theme lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Sweep already leased");
          lease = {
            lease: crypto.randomUUID(),
            directory: base.directory,
            baseline,
          };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return {
            entries: f.entries,
            scenes,
            native: {
              url: sidecar.url,
              sessionID: session.id,
              emptyID: emptySession.id,
            },
            overflow,
            frames: c.frames,
          };
        case "nativeRequest":
          return await native.oc.request(frame.params.path, {
            method: frame.params.method,
            body: frame.params.body,
            directory: native.oc.directory,
          });
        case "scenario": {
          if (frame.params.target !== "tabs-pin") {
            throw new Error("Unknown theme scenario");
          }
          if (frame.params.action === "hold") {
            if (overflow.ids.length) {
              throw new Error("Overflow corpus already seeded");
            }
            const directory = join(root, "projects", "overflow");
            await Deno.mkdir(directory);
            for (let n = 0; n < 251; n++) {
              const id = `tstv1-task-${n}`;
              overflow.ids.push(id);
              f.add({ ...base, id, directory, title: `Session ${n}` });
              overflow.tasks.push(
                (await c.rpc<{ id: string }>("tasks.create", {
                  directory,
                  name: `Qualification task ${n}`,
                  sessions: [id],
                })).id,
              );
            }
          } else if (frame.params.action === "release") {
            f.update(overflow.ids[242], { status: "busy" });
            f.update(overflow.ids[242], { status: "idle" });
            f.update(overflow.ids[241], {
              attention: { ...base.attention, permissions: 1 },
            });
            f.update(overflow.ids[240], { status: "busy" });
            for (let n = 200; n < 220; n++) {
              f.update(overflow.ids[n], { status: "busy" });
            }
          } else throw new Error("Unknown overflow action");
          return overflow;
        }
        case "productRpc": {
          const { method, params } = frame.params;
          if (method === "prefs.set") await nc.rpc(method, params);
          const before = c.frames.length;
          const result = await c.rpc(method, params);
          if (method === "prefs.set") {
            await c.wait((event) =>
              c.frames.indexOf(event) >= before && event.t === "prefs"
            );
          }
          return result;
        }
        case "stop":
          await c.close();
          await nc.close();
          await server.shutdown();
          await f.app.stop();
          await native.stop();
          return null;
        default:
          throw new Error("Command outside theme sweep");
      }
    },
  };
}
