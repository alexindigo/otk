// SPDX-License-Identifier: LGPL-3.0-only
import { join, relative, resolve } from "@std/path";
import { nativeFixture } from "./native-fixture.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { withResources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import { waitFor } from "./opencode.ts";
import { seedProviderPackages } from "./provider-cache.ts";
import { transportScenario } from "./transport-scenario.ts";
import { contractScenario } from "./contract-scenario.ts";
import { transcriptConsumer } from "../reuse/transcript-consumer.ts";
import {
  type ControlRequest,
  type ControlResponse,
  type Json,
  type Profile,
  request,
  type TestLease,
} from "./fixture-control.ts";

// Stdout is exclusively framed control traffic, including during scope export.
console.log = console.info = (...args: unknown[]) => console.error(...args);
function details(error: unknown): NonNullable<ControlResponse["error"]> {
  return error instanceof Error
    ? {
      message: error.message,
      stack: error.stack,
      causes: error instanceof AggregateError
        ? error.errors.map((e) => details(e) as unknown as Json)
        : error.cause
        ? [details(error.cause) as unknown as Json]
        : [],
    }
    : { message: String(error) };
}
async function bind<T>(start: () => Promise<T>): Promise<T> {
  for (let attempt = 0;; attempt++) {
    try {
      return await start();
    } catch (error) {
      if (
        attempt >= 2 ||
        !/EADDRINUSE|[Aa]ddress already in use/.test(String(error))
      ) throw error;
      console.error(
        "Owned listener bind collision before admission; reallocating:",
        error,
      );
    }
  }
}

let stopID: string | undefined;
let shutdownFailure: unknown;
try {
  await withResources("browser worker controller", async () => {
    let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
    let remote: Awaited<ReturnType<typeof nativeFixture>> | undefined;
    let client: WsClient | undefined;
    let baseline: Record<string, Json> = {};
    let lease: TestLease | undefined;
    let profile = "ordinary" as Profile;
    let poisoned = false;
    let snapshotLease = false;
    const directories: string[] = [];
    const createdIDs: string[] = [];
    const gates = new Map<string, () => void>();
    const recordOwnership = async () => {
      const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
      if (!record || !fixture) return;
      const owners = [fixture, ...(remote ? [remote] : [])];
      await Deno.writeTextFile(
        record,
        JSON.stringify({
          pids: [
            Deno.pid,
            ...owners.flatMap((
              owner,
            ) => [
              owner.oc.process.pid!,
              ...owner.servers.map((server) => server.process.pid!),
            ]),
          ],
          ports: [
            ...(transport?.port ? [transport.port] : []),
            ...owners.flatMap((
              owner,
            ) => [
              owner.fake.port,
              owner.oc.port,
              owner.oc.nativePort,
              ...owner.servers.map((server) => server.port),
            ]),
          ],
          sidecarPort: fixture.servers[0]?.port,
        }),
      );
    };
    let stopped = false;
    let chunkTimeout: number | undefined;
    let transport: ReturnType<typeof transportScenario> | undefined;
    let contract: Awaited<ReturnType<typeof contractScenario>> | undefined;
    let bootstrap: {
      busy: { id: string };
      blocked: { id: string };
      directory: string;
    } | undefined;
    let operation: { settled: boolean; error?: string } | undefined;
    let cooling:
      | { a: { id: string }; b: { id: string }; directory: string }
      | undefined;
    let lifecycle: Awaited<ReturnType<typeof transcriptConsumer>> | undefined;
    let secondaryDirectory: string | undefined;
    const subscriptions = new Set<string>();
    const coolingResources = () => {
      if (!cooling || !lifecycle) return null;
      const state = lifecycle.owner.get({
        sidecarId: "consumer",
        sessionID: cooling.a.id,
      })?.state;
      if (!state) return null;
      return {
        temperature: state.temperature,
        messages: state.messageIDs.length,
        messageRecords: Object.keys(state.messagesByID).length,
        replies: state.replyIDs.length,
        replyRecords: Object.keys(state.repliesByID).length,
        content: state.content.messages.length,
        recovering: state.recovering.length,
        pageLoading: state.pageLoading,
        subscribed: subscriptions.has(cooling.a.id),
        readLeases:
          lifecycle.connection.requests.operations(cooling.a.id).filter((
            operation,
          ) =>
            !["succeeded", "failed", "released"].includes(operation.state.phase)
          ).length,
      };
    };
    const resetPrefs = async () => {
      for (const [key, value] of Object.entries(baseline)) {
        const from = client!.frames.length;
        await client!.rpc("prefs.set", { key, value });
        await waitFor(
          () => client!.frames.slice(from).findLast((f) => f.t === "prefs"),
          (f) =>
            f?.t === "prefs" &&
            JSON.stringify(Reflect.get(f.prefs, key)) === JSON.stringify(value),
        );
      }
    };
    const end = async () => {
      if (!lease) throw new Error("No active fixture lease");
      const f = fixture!;
      transport?.release();
      if (remote) {
        remote.fake.releaseAll();
        await waitFor(() => remote!.fake.active, (count) => count === 0);
        if (remote.fake.pending || remote.fake.unexpected) {
          throw new Error("Remote provider lease unsettled");
        }
      }
      f.fake.releaseAll();
      gates.clear();
      if (snapshotLease) {
        await waitFor(() => f.fake.active, (n) => n === 0);
        if (f.fake.pending || f.fake.unexpected) {
          throw new Error("Snapshot provider lease unsettled");
        }
        // A full-population isolated owner is disposed, never reset for reuse.
        await client!.close();
        await f.stop();
        lease = undefined;
        poisoned = true;
        return;
      }
      const sessions = await f.oc.sessionList<
        { id: string; directory: string }
      >(
        "/session",
        lease.directory,
      );
      // Enumerate native creations in the owned directory, including UI/fork helpers.
      for (const session of sessions) {
        const row = session as { id: string; directory?: string };
        if (row.directory !== lease.directory) continue;
        await client!.rpc("session.abort", { sessionID: session.id });
        await client!.rpc("permission.auto", {
          sessionID: session.id,
          enabled: false,
        });
      }
      await waitFor(() => f.fake.active, (n) => n === 0);
      if (f.fake.pending || f.fake.unexpected) {
        throw new Error(
          `Provider lease unsettled: queued=${f.fake.pending}, unexpected=${f.fake.unexpected}`,
        );
      }
      const tasks = await client!.rpc<{ id: string }[]>("tasks.list", {
        directory: lease.directory,
      });
      for (const task of tasks) {
        await client!.rpc("tasks.close", { id: task.id });
      }
      for (const session of sessions) {
        const row = session as { id: string; directory?: string };
        if (row.directory === lease.directory) {
          await f.oc.request(`/session/${session.id}`, {
            method: "DELETE",
            directory: lease.directory,
          });
        }
      }
      await resetPrefs();
      f.fake.requests.length = 0;
      client!.frames.splice(0);
      lease = undefined;
      secondaryDirectory = undefined;
    };
    const dispatch = async (frame: ControlRequest): Promise<unknown> => {
      if (
        frame.command === "start" &&
        frame.params.profile.startsWith("contract-")
      ) {
        if (contract || fixture) throw new Error("Stack already started");
        if (frame.params.version !== nativeVersion) {
          throw new Error("Project/native version mismatch");
        }
        contract = await contractScenario(frame.params.profile);
        return contract.info;
      }
      if (contract) {
        if (frame.command === "stop") stopped = true;
        return await contract.dispatch(frame);
      }
      const p = frame.params;
      if ("lease" in p && p.lease !== undefined && p.lease !== lease?.lease) {
        throw new Error("Stale or foreign fixture lease");
      }
      if (frame.command !== "start" && !fixture) {
        throw new Error("Stack not started");
      }
      switch (frame.command) {
        case "start": {
          if (fixture) throw new Error("Stack already started");
          if (frame.params.version !== nativeVersion) {
            throw new Error("Project/native version mismatch");
          }
          profile = frame.params.profile;
          fixture = await bind(() =>
            nativeFixture(
              profile === "transport-shell" ? { bash: "deny" } : undefined,
            )
          );
          if (profile === "provider-hold") {
            const path = join(fixture.oc.root, "config/opencode/opencode.json");
            const input = JSON.parse(await Deno.readTextFile(path));
            input.provider.fake.options.chunkTimeout = 2000;
            await Deno.writeTextFile(path, JSON.stringify(input));
            await fixture.oc.restart();
            const config = await fixture.oc.request<
              { provider: { fake: { options: { chunkTimeout: number } } } }
            >("/config");
            chunkTimeout = config.provider.fake.options.chunkTimeout;
            if (chunkTimeout !== 2000) {
              throw new Error("Native inactivity profile not applied");
            }
          }
          fixture.fake.strict();
          if (profile === "transport-cooling") {
            const a = await fixture.oc.session<{ id: string }>("/session", {
              method: "POST",
              body: { title: "Large session A" },
            });
            const b = await fixture.oc.session<{ id: string }>("/session", {
              method: "POST",
              body: { title: "Small session B" },
            });
            await fixture.oc.request(`/session/${b.id}/message`, {
              method: "POST",
              body: {
                noReply: true,
                parts: [{ type: "text", text: "Small session text" }],
              },
            });
            fixture.fake.queue({
              chunks: ["OTK_LARGE_SESSION_A_" + "x".repeat(2 * 1024 * 1024)],
              delay: 10,
            });
            await fixture.oc.request(`/session/${a.id}/prompt_async`, {
              method: "POST",
              body: { parts: [{ type: "text", text: "Large reply" }] },
            });
            await waitFor(
              () =>
                fixture!.oc.request<
                  { info: { role: string; time: { completed?: number } } }[]
                >(`/session/${a.id}/message`),
              (rows) =>
                rows.some((row) =>
                  row.info.role === "assistant" && !!row.info.time.completed
                ),
              60_000,
            );
            cooling = { a, b, directory: fixture.oc.directory };
          }
          if (profile === "transport-bootstrap") {
            const busy = await fixture.oc.session<
              { id: string; nativeID: string }
            >("/session", {
              method: "POST",
              body: { title: "Already working" },
            });
            fixture.fake.queueHeld({ chunks: ["Working before OTK connects"] });
            await fixture.oc.request(`/session/${busy.id}/prompt_async`, {
              method: "POST",
              body: { parts: [{ type: "text", text: "Keep working" }] },
            });
            await waitFor(
              () => fixture!.fake.requests,
              (requests) =>
                requests.some((request) =>
                  JSON.stringify(request).includes("Keep working")
                ),
            );
            fixture.fake.queue({
              tool: {
                name: "bash",
                input: {
                  command: "pwd",
                  description: "Pending before OTK connects",
                },
              },
            });
            const blocked = await fixture.oc.session<
              { id: string; nativeID: string }
            >("/session", {
              method: "POST",
              body: { title: "Already blocked" },
            });
            await fixture.oc.request(`/session/${blocked.id}/prompt_async`, {
              method: "POST",
              body: {
                parts: [{ type: "text", text: "Ask before running pwd" }],
              },
            });
            await waitFor(
              () => fixture!.oc.request<{ sessionID: string }[]>("/permission"),
              (rows) => rows.some((row) => row.sessionID === blocked.nativeID),
            );
            bootstrap = { busy, blocked, directory: fixture.oc.directory };
          }
          const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
          if (record) {
            await Deno.writeTextFile(
              record,
              JSON.stringify({
                pids: [Deno.pid, fixture.oc.process.pid!],
                ports: [
                  fixture.fake.port,
                  fixture.oc.port,
                  fixture.oc.nativePort,
                ],
              }),
            );
          }
          if (profile === "fail-start") {
            throw new Error("Forced controller-start failure");
          }
          if (profile.startsWith("transport-")) {
            transport = transportScenario(fixture.oc, profile);
          }
          const server = await bind(() =>
            fixture!.sidecar(
              transport
                ? {
                  ...(profile === "transport-cooling"
                    ? { messages: { coolms: 2500, preloadms: 1500 } }
                    : {}),
                  harness: {
                    url: transport.url,
                    ...(["transport-bootstrap", "transport-enrichment"]
                        .includes(profile)
                      ? {
                        db: join(fixture!.oc.root, "unreadable.db"),
                        requestms: 90000,
                      }
                      : {}),
                    ...(profile === "transport-freeze"
                      ? { heartbeattimeout: 2 }
                      : {}),
                  },
                }
                : {},
            )
          );
          if (record) {
            await Deno.writeTextFile(
              record,
              JSON.stringify({
                pids: [Deno.pid, fixture.oc.process.pid!, server.process.pid!],
                sidecarPort: server.port,
                ports: [
                  fixture.fake.port,
                  fixture.oc.port,
                  server.port,
                  fixture.oc.nativePort,
                ],
              }),
            );
          }
          client = new WsClient(server.url);
          await client.connect();
          await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
          baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
          if (cooling) {
            for (const session of [cooling.a, cooling.b]) {
              await client.rpc("tasks.create", {
                directory: cooling.directory,
                name: session.id,
                sessions: [session.id],
              });
            }
            lifecycle = await transcriptConsumer(server.url, {
              now: Date.now,
              set: (run, ms) => setTimeout(run, ms),
              clear: (timer) =>
                clearTimeout(timer as ReturnType<typeof setTimeout>),
            });
            const subscribe = lifecycle.connection.subscribe.bind(
              lifecycle.connection,
            );
            lifecycle.connection.subscribe = (id, enabled) => {
              if (enabled) subscriptions.add(id);
              else subscriptions.delete(id);
              subscribe(id, enabled);
            };
            await waitFor(
              () => lifecycle!.index.get("consumer", cooling!.a.id),
              Boolean,
            );
          }
          await recordOwnership();
          return {
            root: fixture.oc.root,
            url: server.url,
            nativeUrl: fixture.oc.url,
            binary: nativeBinary,
            version: nativeVersion,
            pids: [Deno.pid, fixture.oc.process.pid!, server.process.pid!],
            ports: [
              fixture.fake.port,
              fixture.oc.port,
              server.port,
              fixture.oc.nativePort,
            ],
          };
        }
        case "beginTest": {
          if (lease || poisoned) throw new Error("Worker lease not clean");
          await resetPrefs();
          const directory = join(
            fixture!.oc.root,
            `project-${
              frame.params.identity.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 80)
            }-${crypto.randomUUID()}`,
          );
          await Deno.mkdir(directory);
          const git = await new Deno.Command("git", {
            args: ["init", "-b", "master", directory],
            stdout: "null",
            stderr: "piped",
            signal: AbortSignal.timeout(5000),
          }).output();
          if (!git.success) {
            throw new Error(new TextDecoder().decode(git.stderr));
          }
          await Deno.writeTextFile(
            join(directory, "README.md"),
            `# ${frame.params.identity}\n`,
          );
          await seedProviderPackages(join(directory, ".opencode"));
          await fixture!.oc.request("/experimental/tool/ids", { directory });
          directories.push(directory);
          lease = { lease: crypto.randomUUID(), directory, baseline };
          return lease;
        }
        case "endTest":
          try {
            await end();
          } catch (error) {
            poisoned = true;
            throw error;
          }
          return null;
        case "queueScript": {
          const provider = frame.params.target === "remote"
            ? remote?.fake
            : fixture!.fake;
          if (!provider) throw new Error("Provider target not acquired");
          const id = crypto.randomUUID();
          const script = {
            chunks: frame.params.chunks,
            ...(frame.params.delay === undefined
              ? {}
              : { delay: frame.params.delay }),
            ...(frame.params.tool ? { tool: frame.params.tool } : {}),
          };
          if (frame.params.gate === "held") {
            const gate = provider.queueHeld(script);
            gates.set(id, () => {
              gate.release();
              gates.delete(id);
            });
          } else if (frame.params.gate === "stepped") {
            const gate = provider.queueStepped(script);
            gates.set(id, () => gate.next());
          } else provider.queue(script);
          return { gate: id };
        }
        case "releaseGate": {
          const release = gates.get(frame.params.gate);
          if (!release) throw new Error("Unknown provider gate");
          release();
          return null;
        }
        case "observe":
          return {
            requests: fixture!.fake.requests,
            transport: transport?.observe() ?? null,
            bootstrap: bootstrap ?? null,
            operation: operation ?? null,
            cooling: cooling ?? null,
            coolingResources: coolingResources(),
            coolingSourceLoaded: cooling &&
                lifecycle?.owner.get({
                  sidecarId: "consumer",
                  sessionID: cooling.a.id,
                })?.state.content.messages.some((message) =>
                  message.parts.some((part) =>
                    part.kind === "text" &&
                    part.blocks.some((block) =>
                      block.b === "paragraph" && block.inline.some((inline) =>
                        inline.i === "text" && inline.text.length >= 2097152
                      )
                    )
                  )
                ) || false,
            frames: client!.frames,
            entries: createdIDs.map((id) => client!.entry(id)),
            chunkTimeout: chunkTimeout ?? null,
            active: fixture!.fake.active,
            pending: fixture!.fake.pending,
            unexpected: fixture!.fake.unexpected,
            directories,
            nativeLog: fixture!.oc.log.slice(-65536),
            sidecarLogs: fixture!.servers.map((s) => s.log.slice(-65536)),
          };
        case "nativeRequest": {
          const params = frame.params;
          if (params.project && profile === "ordinary") {
            throw new Error("Multiple projects require isolated profile");
          }
          if (params.project === "secondary" && !secondaryDirectory) {
            secondaryDirectory = join(lease!.directory, "second-project");
            await Deno.mkdir(secondaryDirectory);
            const git = await new Deno.Command("git", {
              args: ["init", "-b", "master", secondaryDirectory],
              stdout: "null",
              stderr: "piped",
              signal: AbortSignal.timeout(5000),
            }).output();
            if (!git.success) {
              throw new Error(new TextDecoder().decode(git.stderr));
            }
            await seedProviderPackages(join(secondaryDirectory, ".opencode"));
            await fixture!.oc.request("/experimental/tool/ids", {
              directory: secondaryDirectory,
            });
            directories.push(secondaryDirectory);
          }
          const options = {
            method: params.method,
            body: params.body,
            directory: params.project === "secondary"
              ? secondaryDirectory!
              : lease!.directory,
          };
          if (params.path === "/session" && params.method === "POST") {
            const session = await fixture!.oc.session<{ id: string }>(
              "/session",
              {
                ...options,
                method: "POST",
              },
            );
            createdIDs.push(session.id);
            return session;
          }
          return await fixture!.oc.request(params.path, options);
        }
        case "productRpc":
          return await client!.rpc(frame.params.method, frame.params.params);
        case "auxiliary": {
          if (profile === "ordinary") {
            throw new Error("Auxiliary server requires isolated profile");
          }
          const kind = frame.params.kind;
          let session: unknown;
          if (kind === "remote-password") {
            if (remote) throw new Error("Remote server already acquired");
            const logs = Deno.env.get("OTK_TEST_LOG_ROOT");
            const path = join(fixture!.oc.root, "remote-logs");
            await Deno.mkdir(path);
            Deno.env.set("OTK_TEST_LOG_ROOT", path);
            try {
              remote = await nativeFixture();
            } finally {
              if (logs) Deno.env.set("OTK_TEST_LOG_ROOT", logs);
              else Deno.env.delete("OTK_TEST_LOG_ROOT");
            }
            remote.fake.strict();
            session = await remote.oc.session("/session", {
              method: "POST",
              body: { title: "Second host" },
            });
          }
          const owner = kind === "remote-password" ? remote! : fixture!;
          const server = await owner.sidecar({
            server: { origins: [fixture!.servers[0].url] },
            auth: kind === "password" || kind === "remote-password"
              ? {
                type: "password",
                username: "tester",
                password: "secret",
                secretkey: "01234567890123456789012345678901",
              }
              : { type: "" },
          });
          await recordOwnership();
          return { url: server.url, session };
        }
        case "writeProjectFiles":
          for (const [name, text] of Object.entries(frame.params.files)) {
            const target = resolve(lease!.directory, name);
            const path = relative(lease!.directory, target);
            if (!path || path.startsWith("..") || path.startsWith("/")) {
              throw new Error("File outside project root");
            }
            // Refuse symlink parents; never follow fixture-created links out of root.
            let parent = lease!.directory;
            for (const part of path.split("/").slice(0, -1)) {
              parent = join(parent, part);
              await Deno.mkdir(parent, { recursive: true });
              if ((await Deno.lstat(parent)).isSymlink) {
                throw new Error("Symlink parent");
              }
            }
            try {
              if ((await Deno.lstat(target)).isSymlink) {
                throw new Error("Symlink target");
              }
            } catch (error) {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            }
            await Deno.writeTextFile(target, text);
          }
          return null;
        case "restart":
          if (profile === "ordinary") {
            throw new Error("Restart requires isolated profile");
          }
          if (frame.params.target === "native") await fixture!.oc.restart();
          else {
            const server = fixture!.servers.at(-1)!;
            await client!.close();
            await server.stop();
            // The isolated restart journey proves missed terminal data, rather
            // than relying on future chunks after a successful reconnection.
            if (profile === "transport-restart") {
              fixture!.fake.releaseAll();
              gates.clear();
              await waitFor(() => fixture!.fake.active, (count) => count === 0);
              const sessions = await fixture!.oc.sessionList<
                { id: string; nativeID: string }
              >("/session", lease!.directory);
              for (const session of sessions) {
                await waitFor(
                  () =>
                    fixture!.oc.request<
                      { info: { role: string; time: { completed?: number } } }[]
                    >(`/session/${session.id}/message`, {
                      directory: lease!.directory,
                    }),
                  (rows) =>
                    rows.some((row) =>
                      row.info.role === "assistant" &&
                      row.info.time.completed !== undefined
                    ),
                );
              }
            }
            const replacement = await fixture!.sidecar({
              server: { port: server.port },
              state: { path: join(fixture!.oc.root, `otk-${server.port}`) },
            });
            client = new WsClient(replacement.url);
            await client.connect();
            await recordOwnership();
          }
          return null;
        case "scenario":
          if (!transport) throw new Error("No native transport scenario");
          if (
            profile === "transport-cooling" && frame.params.action === "hold"
          ) {
            const id = `opcv1-${frame.params.sessionID}`;
            if (![cooling!.a.id, cooling!.b.id].includes(id)) {
              throw new Error("Foreign cooling session");
            }
            const target = { sidecarId: "consumer", sessionID: id };
            lifecycle!.owner.setDemand({
              scope: {
                sidecarId: "consumer",
                directory: cooling!.directory,
                taskID: id,
              },
              sessions: [target],
              selected: target,
            });
            return null;
          }
          if (
            frame.params.action === "fail" &&
            ["transport-errors-http", "transport-errors-late"].includes(profile)
          ) {
            if (operation) {
              throw new Error("Diagnostic operation already started");
            }
            if (!frame.params.sessionID) {
              throw new Error("Diagnostic session required");
            }
            const result = operation = { settled: false } as {
              settled: boolean;
              error?: string;
            };
            void client!.rpc("session.shell", {
              sessionID: `opcv1-${frame.params.sessionID}`,
              command: "echo never-forwarded",
              ...(profile === "transport-errors-late"
                ? { agent: "missing-late-http-agent" }
                : {}),
            }).then(() => {
              result.settled = true;
            }, (error) => {
              result.settled = true;
              result.error = String(error);
            });
            return null;
          }
          if (
            !["hold", "release", "freeze", "thaw"].includes(frame.params.action)
          ) throw new Error("Action outside native transport scenario");
          transport.control(
            frame.params.action as "hold" | "release" | "freeze" | "thaw",
            frame.params.sessionID,
          );
          return null;
        case "materializeSnapshot": {
          if (profile !== "isolated") {
            throw new Error(
              "Snapshot materialization requires isolated profile",
            );
          }
          // Explicit profile transition, never a dirty-worker reset or DB replacement.
          // Validate the key before stopping any currently owned service.
          const { SessionScale } = await import("./session-scale.ts");
          await SessionScale.template(frame.params.key);
          if (
            fixture!.fake.pending || fixture!.fake.active ||
            fixture!.fake.requests.length
          ) {
            throw new Error(
              "Snapshot requires an unused isolated provider lease",
            );
          }
          await end();
          await client!.close();
          await fixture!.stop();
          fixture = await nativeFixture(undefined, {
            snapshot: frame.params.key,
          });
          fixture.fake.strict();
          const server = await fixture.sidecar();
          client = new WsClient(server.url);
          await client.connect();
          baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
          lease = {
            lease: crypto.randomUUID(),
            directory: fixture.oc.directory,
            baseline,
          };
          snapshotLease = true;
          const stack = {
            root: fixture.oc.root,
            url: server.url,
            nativeUrl: fixture.oc.url,
            binary: nativeBinary,
            version: nativeVersion,
            pids: [Deno.pid, fixture.oc.process.pid!, server.process.pid!],
            ports: [
              fixture.fake.port,
              fixture.oc.port,
              server.port,
              fixture.oc.nativePort,
            ],
          };
          const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
          if (record) {
            await Deno.writeTextFile(
              record,
              JSON.stringify({
                pids: stack.pids,
                ports: stack.ports,
                sidecarPort: server.port,
              }),
            );
          }
          return { stack, lease };
        }
        case "stop":
          stopped = true;
          return null;
      }
    };
    const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    let signalled = false;
    const terminate = () => {
      signalled = true;
      void reader.cancel();
    };
    Deno.addSignalListener("SIGTERM", terminate);
    Deno.addSignalListener("SIGINT", terminate);
    try {
      while (!stopped && !signalled) {
        const read = await reader.read();
        if (read.done) break;
        buffer += read.value;
        if (buffer.length > 2 * 1024 * 1024) {
          throw new Error("Oversized control frame");
        }
        let newline: number;
        while (!stopped && (newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let id = "invalid";
          let result: ControlResponse;
          try {
            const frame = request(JSON.parse(line));
            id = frame.id;
            if (frame.command === "stop") stopID = id;
            const value = await dispatch(frame);
            if (frame.command === "stop") continue;
            result = { v: 1, id, ok: true, result: (value ?? null) as Json };
          } catch (error) {
            result = { v: 1, id, ok: false, error: details(error) };
            if (!fixture || !client) stopped = true;
          }
          await Deno.stdout.write(
            new TextEncoder().encode(JSON.stringify(result) + "\n"),
          );
        }
      }
    } finally {
      Deno.removeSignalListener("SIGTERM", terminate);
      Deno.removeSignalListener("SIGINT", terminate);
      transport?.release();
      remote?.fake.releaseAll();
      lifecycle?.stop();
      await remote?.stop();
      fixture?.fake.releaseAll();
      await client?.close();
      await fixture?.stop();
    }
    if (profile === "fail-teardown") {
      throw new Error("Forced controller teardown failure");
    }
  });
} catch (error) {
  shutdownFailure = error;
}
if (stopID) {
  const result: ControlResponse = shutdownFailure
    ? { v: 1, id: stopID, ok: false, error: details(shutdownFailure) }
    : { v: 1, id: stopID, ok: true, result: null };
  await Deno.stdout.write(
    new TextEncoder().encode(JSON.stringify(result) + "\n"),
  );
}
if (shutdownFailure) throw shutdownFailure;
