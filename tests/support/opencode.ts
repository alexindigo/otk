// SPDX-License-Identifier: LGPL-3.0-only
import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { fromFileUrl, join } from "@std/path";
import type { FakeLlm } from "./fake-llm.ts";
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
  static async start(
    provider: FakeLlm,
    permission: Record<string, "ask" | "allow" | "deny"> = { bash: "ask" },
    options: {
      prepare?(test: OpencodeTest): Promise<void>;
      env?: Record<string, string>;
      config?: Record<string, unknown>;
    } = {},
  ): Promise<OpencodeTest> {
    const test = new OpencodeTest();
    const state = fromFileUrl(new URL("../../.test-state/", import.meta.url));
    await Deno.mkdir(state, { recursive: true });
    test.root = await Deno.makeTempDir({ dir: state, prefix: "oc-" });
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
    };
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
        },
      }),
    );
    test.port = await freePort();
    test.url = `http://127.0.0.1:${test.port}`;
    test.db = join(env.XDG_DATA_HOME, "opencode/opencode.db");
    test.#env = env;
    test.process = spawn("/usr/local/bin/opencode", [
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
      await waitFor(
        async () =>
          (await fetch(test.url + "/global/health", {
            signal: AbortSignal.timeout(5000),
          })).json(),
        (health) => health.healthy === true,
        60_000,
      );
    } catch (error) {
      await test.stop();
      throw new Error(`${error}\n${test.log}`);
    }
    return test;
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
    this.process = spawn("/usr/local/bin/opencode", [
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
    this.process.stdout!.on("data", (chunk) => {
      this.log += chunk.toString();
    });
    this.process.stderr!.on("data", (chunk) => {
      this.log += chunk.toString();
    });
    await waitFor(
      async () =>
        (await fetch(this.url + "/global/health", {
          signal: AbortSignal.timeout(5000),
        })).json(),
      (health) => health.healthy === true,
      60_000,
    );
  }
  async stop(): Promise<void> {
    if (!this.process?.pid || this.process.exitCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      this.process.once("exit", () => resolve())
    );
    process.kill(-this.process.pid, "SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (this.process.exitCode === null) {
            process.kill(-this.process.pid!, "SIGKILL");
          }
          resolve();
        }, 2000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    await exited;
  }
}
