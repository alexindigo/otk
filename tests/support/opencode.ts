// SPDX-License-Identifier: LGPL-3.0-only
import type { ChildProcess } from "node:child_process";
import { join } from "@std/path";
import type { FakeLlm } from "./fake-llm.ts";
import { acquire, tempDir } from "./resources.ts";
import { ownedProcess } from "./process.ts";
import { nativeVersion, seedProviderPackages } from "./provider-cache.ts";
import { nativeBinary } from "./native.ts";
export function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
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
      test.root = await tempDir("oc-");
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
        const text = new TextDecoder().decode(chunk);
        test.log += text;
        Deno.writeTextFileSync(join(test.root, "process.log"), text, {
          append: true,
        });
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
  async request<T>(
    path: string,
    options: { method?: string; body?: unknown; directory?: string } = {},
  ): Promise<T> {
    const url = new URL(this.url + path);
    url.searchParams.set("directory", options.directory || this.directory);
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
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
      this.log += chunk.toString();
    });
    this.process.stderr!.on("data", (chunk) => {
      this.log += chunk.toString();
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
