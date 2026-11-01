// SPDX-License-Identifier: LGPL-3.0-only
import type { ChildProcess } from "node:child_process";
import { join } from "@std/path";
import type { FakeLlm } from "./fake-llm.ts";
import { acquire, resources, tempDir } from "./resources.ts";
import { ownedProcess } from "./process.ts";
import { nativeVersion, seedProviderPackages } from "./provider-cache.ts";
import { nativeBinary } from "./native.ts";
import { opencodeV1SessionID } from "@otk/harness-opencode-v1";
import { isSessionID } from "@otk/protocol";
function sessionFixture<T extends { id: string }>(
  raw: T,
): T & { nativeID: string } {
  const parentID = Reflect.get(raw, "parentID");
  return {
    ...raw,
    id: opencodeV1SessionID.encode(raw.id),
    ...(typeof parentID === "string"
      ? { parentID: opencodeV1SessionID.encode(parentID) }
      : {}),
    nativeID: raw.id,
  };
}
export function freePort(): number {
  const root = Deno.env.get("OTK_TEST_PORTS_ROOT");
  if (root) Deno.mkdirSync(root, { recursive: true });
  for (let attempt = 0; attempt < 64; attempt++) {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    try {
      if (root) {
        const record = join(root, `${port}.json`);
        const owner = crypto.randomUUID();
        try {
          Deno.writeTextFileSync(
            record,
            JSON.stringify({ owner, pid: Deno.pid, port }),
            { createNew: true },
          );
        } catch (error) {
          if (error instanceof Deno.errors.AlreadyExists) continue;
          throw error;
        }
        resources().defer(`port lease ${port}`, async () => {
          const current = JSON.parse(await Deno.readTextFile(record));
          if (current.owner !== owner) {
            throw new Error("Port lease ownership changed");
          }
          await Deno.remove(record);
        });
      }
      return port;
    } finally {
      listener.close();
    }
  }
  throw new Error("Run port allocator exhausted its admission attempts");
}
export async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (predicate(value)) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting: ${JSON.stringify(last)}`);
}
export class OpencodeTest {
  root!: string;
  directory!: string;
  port!: number;
  url!: string;
  db!: string;
  process!: ChildProcess;
  log = "";
  #env: Record<string, string> = {};
  #logPath = "";
  #record(chunk: Uint8Array): void {
    const text = new TextDecoder().decode(chunk);
    this.log += text;
    Deno.writeTextFileSync(this.#logPath, text, { append: true });
  }
  #stop: () => Promise<void> = () => Promise.resolve();
  static async start(
    provider: FakeLlm,
    permission: Record<string, "ask" | "allow" | "deny"> = { bash: "ask" },
    options: {
      prepare?(test: OpencodeTest): Promise<void>;
      env?: Record<string, string>;
      config?: Record<string, unknown>;
      /** Only cache preparation and the deliberate uncached readiness control. */
      packageCache?: false;
      providers?: Record<string, {
        fake: FakeLlm;
        name?: string;
        models: Record<string, Record<string, unknown>>;
      }>;
    } = {},
  ): Promise<OpencodeTest> {
    return await acquire("native fixture", async () => {
      const providers = Object.entries(options.providers ?? {});
      const instances = new Set([provider]);
      for (const [id, entry] of providers) {
        if (id === "fake" || instances.has(entry.fake)) {
          throw new Error(
            "Extra providers need unique IDs and FakeLlm instances",
          );
        }
        instances.add(entry.fake);
      }
      const test = new OpencodeTest();
      const identity = Deno.env.get("OTK_TEST_STACK_ID")?.replace(
        /[^a-zA-Z0-9.-]/g,
        "-",
      ).slice(0, 190);
      test.root = await tempDir(identity ? `oc-${identity}-` : "oc-");
      test.#logPath = Deno.env.get("OTK_TEST_LOG_ROOT")
        ? join(Deno.env.get("OTK_TEST_LOG_ROOT")!, "native.log")
        : join(test.root, "process.log");
      Deno.writeTextFileSync(test.#logPath, "", { append: true });
      test.directory = join(test.root, "project");
      await Deno.mkdir(test.directory);
      const git = await new Deno.Command("git", {
        args: ["init", "-b", "master", test.directory],
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!git.success) throw new Error(new TextDecoder().decode(git.stderr));
      await Deno.writeTextFile(
        join(test.directory, "README.md"),
        "# OTK fixture\n",
      );
      await options.prepare?.(test);
      const env: Record<string, string> = {
        ...Deno.env.toObject(),
        OPENCODE_PURE: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        ...options.env,
        TMPDIR: join(test.root, "tmp"),
      };
      await Deno.mkdir(env.TMPDIR);
      for (
        const [variable, directory] of Object.entries({
          XDG_CONFIG_HOME: "config",
          XDG_DATA_HOME: "data",
          XDG_STATE_HOME: "state",
          XDG_CACHE_HOME: "cache",
        })
      ) {
        env[variable] = join(test.root, directory);
        await Deno.mkdir(env[variable]);
      }
      await Deno.mkdir(join(env.XDG_CONFIG_HOME, "opencode"));
      if (options.packageCache !== false) {
        await seedProviderPackages(join(env.XDG_CONFIG_HOME, "opencode"));
        await seedProviderPackages(join(test.directory, ".opencode"));
      }
      await Deno.writeTextFile(
        join(env.XDG_CONFIG_HOME, "opencode/opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          autoupdate: false,
          share: "disabled",
          model: "fake/scripted",
          permission,
          ...options.config,
          provider: {
            ...options.config?.provider as Record<string, unknown>,
            fake: {
              npm: "@ai-sdk/openai-compatible",
              options: {
                baseURL: `http://127.0.0.1:${provider.port}/v1`,
                apiKey: "x",
              },
              models: {
                scripted: { name: "scripted" },
                "gpt-scripted": { name: "gpt-scripted" },
              },
            },
            ...Object.fromEntries(providers.map(([id, entry]) => [id, {
              npm: "@ai-sdk/openai-compatible",
              ...(entry.name ? { name: entry.name } : {}),
              options: {
                baseURL: `http://127.0.0.1:${entry.fake.port}/v1`,
                apiKey: "x",
              },
              models: entry.models,
            }])),
          },
        }),
      );
      test.port = await freePort();
      test.url = `http://127.0.0.1:${test.port}`;
      test.db = join(env.XDG_DATA_HOME, "opencode/opencode.db");
      test.#env = env;
      const owner = ownedProcess(nativeBinary, [
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(test.port),
      ], {
        cwd: test.directory,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      test.process = owner.child;
      test.#stop = owner.stop;
      const log = (chunk: Uint8Array) => {
        test.#record(chunk);
      };
      test.process.stdout!.on("data", log);
      test.process.stderr!.on("data", log);
      try {
        await test.#ready();
      } catch (error) {
        await test.stop();
        throw new Error(`${error}\n${test.log}`);
      }
      return test;
    });
  }
  /** OTK-facing session fixture, with the native identity retained explicitly. */
  async session<T extends { id: string }>(
    path: "/session",
    options: { method: string; body?: unknown; directory?: string },
  ): Promise<T & { nativeID: string }> {
    if (options.method !== "POST") {
      throw new Error("Session fixtures require creation");
    }
    return sessionFixture(await this.request<T>(path, options));
  }
  /** OTK-facing metadata collection; use request() when observing native rows. */
  async sessionList<T extends { id: string }>(
    path: string,
    directory?: string,
  ): Promise<(T & { nativeID: string })[]> {
    return (await this.request<T[]>(path, { directory })).map(sessionFixture);
  }
  /** Native reads/seeds keep raw responses. Qualified fixture references decode
   * only in typed session paths and session-create parent inputs. */
  async request<T>(
    path: string,
    options: { method?: string; body?: unknown; directory?: string } = {},
  ): Promise<T> {
    path = path.replace(
      /^\/session\/([^/]+)/,
      (segment, id: string) =>
        isSessionID(id)
          ? `/session/${opencodeV1SessionID.decode(id)}`
          : segment,
    );
    let body = options.body;
    if (path === "/session" && body && typeof body === "object") {
      const parentID = Reflect.get(body, "parentID");
      if (isSessionID(parentID)) {
        body = { ...body, parentID: opencodeV1SessionID.decode(parentID) };
      }
    }
    const url = new URL(this.url + path);
    url.searchParams.set("directory", options.directory || this.directory);
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`${response.status}: ${await response.text()}`);
    }
    return response.status === 204 ? undefined as T : await response.json();
  }
  async restart(): Promise<void> {
    await this.stop();
    const owner = ownedProcess(nativeBinary, [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(this.port),
    ], {
      cwd: this.directory,
      env: this.#env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = owner.child;
    this.#stop = owner.stop;
    this.process.stdout!.on("data", (chunk) => {
      this.#record(chunk);
    });
    this.process.stderr!.on("data", (chunk) => {
      this.#record(chunk);
    });
    try {
      await this.#ready();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  /** HTTP admission is earlier than native custom-tool dependency completion. */
  async #ready(): Promise<void> {
    const deadline = Date.now() + 60_000;
    const health = await waitFor(
      async () =>
        (await fetch(this.url + "/global/health", {
          signal: AbortSignal.timeout(5000),
        })).json(),
      (health) => health.healthy === true,
      60_000,
    );
    if (health.version !== nativeVersion) {
      throw new Error(
        `Native fixture requires opencode ${nativeVersion}, received ${health.version}`,
      );
    }
    const url = new URL(this.url + "/experimental/tool/ids");
    url.searchParams.set("directory", this.directory);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!response.ok) {
      throw new Error(
        `Native tool readiness ${response.status}: ${await response.text()}`,
      );
    }
    const tools: unknown = await response.json();
    if (
      !Array.isArray(tools) || !tools.length ||
      !tools.every((tool) => typeof tool === "string")
    ) {
      throw new Error(
        "Native tool registry returned an invalid readiness snapshot",
      );
    }
  }
  async stop(): Promise<void> {
    await this.#stop();
  }
}
