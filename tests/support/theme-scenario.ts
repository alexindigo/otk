// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { fixture } from "./config.ts";
import { nativeFixture } from "./native-fixture.ts";
import { seedBrowserSession } from "./browser-native.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { consumerAssets } from "./consumer-builds.ts";
import { serve } from "./http.ts";
import { WsClient } from "./ws-client.ts";
import { themeManifest } from "./theme-manifest.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import {
  registerAgents,
  registerModels,
  registerPermissions,
  registerQuestions,
  registerSessionActions,
  registerUsage,
} from "../../core/mod.ts";
import { themeContent } from "./theme-content.ts";
import { fixturePage } from "./message-pages.ts";
import { FakeLlm } from "./fake-llm.ts";
import { OperationFailure } from "@otk/protocol";
import {
  type AssistantMessage,
  type Message,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import { publishUsage, turnDetail } from "./usage-summary.ts";
import { themeUsage } from "./theme-usage.ts";
import { resources } from "./resources.ts";
import { OtkDb, permissionMigrations, PermissionStore } from "@otk/store";
import type { PermissionRequest } from "@otk/protocol";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";
/** One real native stack plus accurately labelled public external-backend scenes. */
export async function themeScenario() {
  const root = await fixture(),
    native = await nativeFixture({ bash: "ask", edit: "ask", read: "ask" }, {
      providers: {
        fake2: {
          fake: new FakeLlm(),
          name: "Second fixture provider",
          models: {
            scripted: {
              name: "Scripted with variants",
              release_date: "2026-10-17",
              variants: {
                low: { reasoningEffort: "low" },
                high: { reasoningEffort: "high" },
              },
            },
            plain: { name: "Plain model", release_date: "2026-10-16" },
          },
        },
      },
      config: {
        default_agent: "reviewer",
        agent: {
          reviewer: {
            mode: "primary",
            model: "fake2/scripted",
            variant: "high",
            color: "#12abEF",
          },
          build: { model: "fake2/scripted", variant: "high" },
          plan: { model: "fake2/scripted", variant: "low" },
        },
      },
    });
  const session = await seedBrowserSession(native.oc, {
    title: "Native theme corpus",
    messages: [{
      parts: [{ type: "text", text: "Fixed native source for theme evidence" }],
    }],
  });
  const automaticGate = Promise.withResolvers<void>();
  let automaticHeld = false, automaticReplying = false;
  const automaticProxy = serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, async (request) => {
    const url = new URL(request.url);
    if (automaticHeld && /\/permission\/[^/]+\/reply$/.test(url.pathname)) {
      automaticReplying = true;
      await automaticGate.promise;
    }
    url.port = String(native.oc.port);
    return await fetch(new Request(url, request));
  });
  resources().defer("theme automatic proxy", () => {
    automaticGate.resolve();
    return automaticProxy.shutdown();
  });
  const sidecar = await native.sidecar({
    harness: {
      url: `http://127.0.0.1:${automaticProxy.addr.port}`,
      db: native.oc.db,
    },
  });
  const nc = new WsClient(sidecar.url);
  await nc.connect(native.oc.directory);
  await nc.rpc("layout.patch", {
    rightCollapsed: false,
    rightView: "sessions",
  });
  const emptySession = await native.oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Empty native session" },
  });
  const automatic = await native.oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Quiet automatic session" },
  });
  await native.oc.session("/session", {
    method: "POST",
    body: { title: "Inherited helper", parentID: automatic.id },
  });
  await nc.rpc("tasks.create", {
    directory: native.oc.directory,
    name: "Retained native task",
    sessions: [session.id],
  });
  const dist = await consumerAssets("theme-scenes");
  const styles = await consumerAssets("styles");
  const dialog = await consumerAssets("dialog");
  const context = await consumerAssets("context");
  const ui = await consumerAssets("ui");
  const manifest = await themeManifest();
  const server = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/manifest.json") return Response.json(manifest);
      const mount = path.startsWith("/styles/")
        ? "styles"
        : path.startsWith("/dialog/")
        ? "dialog"
        : path.startsWith("/context/")
        ? "context"
        : path.startsWith("/ui/")
        ? "ui"
        : undefined;
      const base = mount === "styles"
        ? styles
        : mount === "dialog"
        ? dialog
        : mount === "context"
        ? context
        : mount === "ui"
        ? ui
        : dist;
      const name = mount ? path.slice(mount.length + 1) : path;
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
  await c.connect(f.entries[0].directory);
  const base = f.entries[0];
  const corpus = await themeContent(base.directory);
  let contentState: keyof typeof corpus.collections = "reading";
  const usage = themeUsage(corpus.sessionID);
  let usageSeeded = false;
  const usageLedger = () => {
    const messages: Message[] = corpus.collections[contentState];
    return new UsageLedger(
      corpus.sessionID,
      messages.filter((m): m is AssistantMessage => m.role === "assistant").map(
        usageHeader,
      ),
    );
  };
  let response = Promise.withResolvers<void>();
  const getSession = f.app.backend.core.getSession;
  f.app.backend.core.getSession = async (id) => {
    const session = await getSession(id);
    return id === corpus.sessionID && contentState === "revert"
      ? {
        ...session,
        revert: {
          messageID: "prompt",
          messageCount: 1,
          files: [{ path: "revert.txt", additions: 1, deletions: 1 }],
        },
      }
      : session;
  };
  const listMessages = f.app.backend.core.listMessages;
  f.app.backend.core.listMessages = async (id, opts) =>
    id === corpus.sessionID
      ? {
        ...fixturePage(
          id,
          corpus.collections[contentState],
          opts.before,
          await f.app.backend.core.getSession(id),
        ),
        recovering: contentState === "recovery"
          ? [{ messageID: "reading", partID: "prose", generation: 1 }]
          : [],
      }
      : listMessages(id, opts);
  f.add({ ...base, id: corpus.sessionID, title: "Public content contract" });
  let attentionRegistered = false;
  function contentCapabilities() {
    if (attentionRegistered) return;
    attentionRegistered = true;
    Object.assign(f.app.backend.capabilities, {
      agents: {
        listAgents: () =>
          Promise.resolve([
            { name: "action", color: "accent" },
            { name: "alternate", color: "secondary" },
            { name: "literal", color: "#12abEF" },
            { name: "uncoloured" },
            ...(contentState.startsWith("labels")
              ? [{
                name:
                  "review the complete dependency graph and every affected consumer",
              }]
              : []),
          ]),
      },
      models: {
        listModels: () =>
          Promise.resolve(
            contentState.startsWith("usage-") ||
              contentState.startsWith("labels")
              ? usage.catalog
              : {
                defaultState: "unknown",
                providers: [{
                  id: "fake2",
                  name: "Second fixture provider",
                  models: [{
                    id: "scripted",
                    name: "Scripted with variants",
                    variants: ["low", "high"],
                    status: "active",
                    free: true,
                  }],
                }],
              },
          ),
      },
      usage: {
        getUsage: (_id: string, turnID: string) =>
          Promise.resolve(turnDetail(usageLedger().snapshot(), turnID)),
      },
      permissions: {
        listPermissions: (id: string) =>
          Promise.resolve(
            id === corpus.sessionID &&
              (contentState.startsWith("permission") ||
                contentState === "labels-permission")
              ? [{
                id: "permission",
                sessionID: id,
                kind: contentState === "permission-read"
                  ? "read"
                  : contentState === "permission-edit"
                  ? "edit"
                  : "bash",
                title: "Run the proof",
                patterns: [
                  contentState === "permission"
                    ? "echo proof"
                    : base.directory + "/README.md",
                ],
                alwaysPatterns: ["echo *"],
                detail: contentState === "permission-read"
                  ? { kind: "generic", summary: "Read README.md" }
                  : contentState === "permission-edit"
                  ? {
                    kind: "edit",
                    files: [{
                      path: base.directory + "/README.md",
                      status: "modified",
                      additions: 1,
                      deletions: 1,
                      hunks: [{
                        oldStart: 1,
                        newStart: 1,
                        oldLines: 1,
                        newLines: 1,
                        lines: [{
                          kind: "del",
                          text: "# OTK fixture",
                          oldNo: 1,
                        }, {
                          kind: "add",
                          text: "# Changed fixture",
                          newNo: 1,
                        }],
                      }],
                    }],
                  }
                  : { kind: "bash", command: "echo proof" },
                time: 1,
              }]
              : [],
          ),
        replyPermission: async () => {
          await response.promise;
          throw new OperationFailure(
            "rejected",
            "request.params",
            new Error("private SQL /secret/path"),
          );
        },
      },
      questions: {
        listQuestions: (id: string) =>
          Promise.resolve(
            id === corpus.sessionID &&
              (contentState === "question" ||
                contentState === "labels-question")
              ? [{
                id: "question",
                sessionID: id,
                questions: [
                  {
                    header: "Rendering",
                    text: "Choose the output",
                    options: [{
                      label: contentState === "labels-question"
                        ? "Review the complete dependency graph and every affected consumer"
                        : "Typed",
                      description: "OTK shapes",
                    }, {
                      label: "Raw",
                      description: "Harness shapes",
                    }],
                    multiple: false,
                    custom: true,
                  },
                  {
                    header: "Details",
                    text: "Choose details",
                    options: [
                      { label: "Files", description: "Include files" },
                      {
                        label: "Tools",
                        description: "Include tools",
                      },
                    ],
                    multiple: true,
                    custom: true,
                  },
                ],
              }]
              : [],
          ),
        answerQuestion: async () => {
          await response.promise;
          throw new OperationFailure(
            "rejected",
            "request.params",
            new Error("private SQL /secret/path"),
          );
        },
      },
    });
    registerPermissions(f.app.connections.rpc, f.app.backend);
    registerQuestions(f.app.connections.rpc, f.app.backend);
    registerModels(f.app.connections.rpc, f.app.backend);
    registerUsage(f.app.connections.rpc, f.app.backend);
    registerAgents(f.app.connections.rpc, f.app.backend);
  }
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
    status: "busy",
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
      automaticProxy.addr.port,
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
              automaticID: automatic.id,
              automaticReplying,
            },
            overflow,
            content: {
              sessionID: corpus.sessionID,
              states: Object.keys(corpus.collections),
            },
            frames: c.frames,
          };
        case "nativeRequest":
          if (
            frame.params.path === "/session" && frame.params.method === "POST"
          ) {
            if (
              frame.params.body && typeof frame.params.body === "object" &&
              "messages" in frame.params.body
            ) {
              return await seedBrowserSession(
                native.oc,
                frame.params.body as Record<string, unknown>,
              );
            }
            return await native.oc.session("/session", {
              method: "POST",
              body: frame.params.body,
            });
          }
          return await native.oc.request(frame.params.path, {
            method: frame.params.method,
            body: frame.params.body,
            directory: native.oc.directory,
          });
        case "scenario": {
          if (frame.params.sessionID === "tstv1-native-interrupt") {
            native.fake.queueHeld({ chunks: ["continuing "] });
            await nc.rpc("session.prompt", {
              sessionID: emptySession.id,
              mode: "normal",
              model: { provider: "fake", model: "scripted" },
              parts: [{ kind: "text", text: "Continue slowly" }],
            });
            return null;
          }
          if (frame.params.sessionID === "tstv1-native-auto") {
            if (frame.params.action === "hold") {
              automaticHeld = true;
              await nc.rpc("permission.auto", {
                sessionID: automatic.id,
                enabled: true,
              });
              native.fake.queue({
                tool: {
                  name: "bash",
                  input: {
                    command:
                      "printf quiet-auto > quiet-auto.txt; printf quiet-auto",
                    description: "Quiet automatic approval",
                  },
                },
              }, { chunks: ["Quiet automatic reply completed"] });
              await nc.rpc("session.prompt", {
                sessionID: automatic.id,
                mode: "normal",
                model: { provider: "fake", model: "scripted" },
                parts: [{ kind: "text", text: "Fixed quiet automatic state" }],
              });
            } else if (frame.params.action === "release") {
              automaticHeld = false;
              automaticGate.resolve();
            } else if (frame.params.action === "fail") {
              await nc.rpc("permission.activity", { sessionID: automatic.id });
              const db = new OtkDb(
                join(native.oc.root, `otk-${sidecar.port}`),
                [permissionMigrations],
                { busyms: 5000 },
              );
              try {
                const store = new PermissionStore(db);
                for (
                  const [id, error] of [[
                    "failed-display-fixture",
                    "Stored failure fixture",
                  ], ["unconfirmed-display-fixture", undefined]] as const
                ) {
                  const request: PermissionRequest = {
                    id,
                    sessionID: automatic.id,
                    kind: "bash",
                    title: "bash",
                    patterns: [`printf ${id}`],
                    alwaysPatterns: [],
                    time: 1793736000000,
                    detail: { kind: "bash", command: `printf ${id}` },
                  };
                  const record = store.start({
                    session: automatic.id,
                    requestID: id,
                    request: JSON.stringify(request),
                    reply: "once",
                    source: "auto",
                    owner: automatic.id,
                  });
                  if (error) store.finish(record, { outcome: "failed", error });
                }
              } finally {
                db.close();
              }
            } else throw new Error("Unknown automatic theme state");
            return null;
          }
          if (frame.params.sessionID) {
            const name = frame.params.sessionID.slice("tstv1-".length);
            if (!(name in corpus.collections)) {
              throw new Error("Unknown fixed theme content");
            }
            contentState = name as keyof typeof corpus.collections;
            contentCapabilities();
            response.resolve();
            response = Promise.withResolvers<void>();
            // Summaries belong to the digest owner, not metadata upserts.
            const previousDigest = f.app.index.get(corpus.sessionID)!.digest;
            const revision = previousDigest.revision + 1;
            f.app.index.applyDigest({
              id: corpus.sessionID,
              revision,
              summary: {
                state: "unavailable",
                revision,
                total: undefined,
                last: undefined,
              },
              turns: { upsert: {}, remove: Object.keys(previousDigest.turns) },
              deleted: null,
            });
            f.update(corpus.sessionID, {
              status: contentState === "streaming" || contentState === "queued"
                ? "busy"
                : contentState === "retry"
                ? "retry"
                : "idle",
              retry: contentState === "retry"
                ? {
                  attempt: 2,
                  message: "Provider is temporarily unavailable",
                  next: 1793736006000,
                }
                : undefined,
            });
            if (contentState.startsWith("usage-")) {
              if (!usageSeeded) {
                usageSeeded = true;
                for (const name of ["helper", "unopened"]) {
                  const id = `tstv1-usage-${name}`;
                  f.add({
                    ...base,
                    id,
                    title: "Charged " + name +
                      " with a deliberately long title to test truncation",
                    ...(name === "helper"
                      ? {
                        parentID: corpus.sessionID,
                        attention: { ...base.attention, questions: 1 },
                      }
                      : {}),
                  });
                  publishUsage(
                    f.app.index,
                    new UsageLedger(id, [{
                      ...usageHeader(
                        usage.collections["usage-small"][1] as AssistantMessage,
                      ),
                      id: name,
                    }]).snapshot(),
                  );
                }
              }
              publishUsage(f.app.index, usageLedger().snapshot());
            }
            return null;
          }
          if (
            frame.params.action === "fail" && frame.params.target !== "tabs-pin"
          ) {
            response.resolve();
            return null;
          }
          if (frame.params.target !== "tabs-pin") {
            throw new Error("Unknown theme scenario");
          }
          if (frame.params.action === "hold") {
            if (overflow.ids.length) {
              throw new Error("Overflow corpus already seeded");
            }
            const directory = join(root, "projects", "overflow");
            await Deno.mkdir(directory);
            for (let n = 0; n < 300; n++) {
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
          automaticGate.resolve();
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
