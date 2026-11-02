// SPDX-License-Identifier: LGPL-3.0-only
import { join, relative, resolve } from "@std/path";
import { nativeFixture } from "./native-fixture.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { withResources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import { waitFor } from "./opencode.ts";
import { seedProviderPackages } from "./provider-cache.ts";
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
    let client: WsClient | undefined;
    let baseline: Record<string, Json> = {};
    let lease: TestLease | undefined;
    let profile = "ordinary" as Profile;
    let poisoned = false;
    let snapshotLease = false;
    const directories: string[] = [];
    const gates = new Map<string, () => void>();
    let stopped = false;
    let chunkTimeout: number | undefined;
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
    };
    const dispatch = async (frame: ControlRequest): Promise<unknown> => {
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
          fixture = await bind(() => nativeFixture());
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
          const server = await bind(() => fixture!.sidecar());
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
          const id = crypto.randomUUID();
          const script = { chunks: frame.params.chunks };
          if (frame.params.gate === "held") {
            const gate = fixture!.fake.queueHeld(script);
            gates.set(id, () => {
              gate.release();
              gates.delete(id);
            });
          } else if (frame.params.gate === "stepped") {
            const gate = fixture!.fake.queueStepped(script);
            gates.set(id, () => gate.next());
          } else fixture!.fake.queue(script);
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
          const options = {
            method: params.method,
            body: params.body,
            directory: lease!.directory,
          };
          return params.path === "/session" && params.method === "POST"
            ? await fixture!.oc.session("/session", {
              ...options,
              method: "POST",
            })
            : await fixture!.oc.request(params.path, options);
        }
        case "productRpc":
          return await client!.rpc(frame.params.method, frame.params.params);
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
          await fixture!.oc.restart();
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
