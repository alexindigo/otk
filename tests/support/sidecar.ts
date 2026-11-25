// SPDX-License-Identifier: LGPL-3.0-only
import type { ChildProcess } from "node:child_process";
import { fromFileUrl, join } from "@std/path";
import { stringify } from "@std/toml";
import {
  loadServiceConfig,
  mergeLeafWise,
  type ServiceConfig,
  type Tree,
} from "../../core/mod.ts";
import { waitFor } from "./opencode.ts";
import { otkEndpoint } from "./bound-endpoint.ts";
import { FreezeProxy } from "./freeze-proxy.ts";
import type { NativeFixture } from "./native-fixture.ts";
import { acquire } from "./resources.ts";
import { ownedProcess } from "./process.ts";
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export class SidecarTest {
  process!: ChildProcess;
  port!: number;
  url!: string;
  nativePort!: number;
  statePath!: string;
  log = "";
  #stopProcess: () => Promise<void> = () => Promise.resolve();
  #launch!: () => Promise<void>;
  #proxy?: FreezeProxy;
  async rssKiB(): Promise<number> {
    const pid = this.process.pid;
    if (!pid || this.process.exitCode !== null) {
      throw new Error("Sidecar is not running");
    }
    // Deno guards all /proc status reads behind --allow-all. Observe only our
    // owned child through the test runner's existing subprocess permission.
    const output = await new Deno.Command("/usr/bin/cat", {
      args: [`/proc/${pid}/status`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(new TextDecoder().decode(output.stderr));
    }
    const status = new TextDecoder().decode(output.stdout);
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (!match) throw new Error(`VmRSS missing for sidecar PID ${pid}`);
    return Number(match[1]);
  }
  static async start(
    oc:
      & Pick<NativeFixture, "root" | "directory" | "db" | "url">
      & Partial<Pick<NativeFixture, "kind" | "discoveryEnv">>,
    overrides: DeepPartial<
      Omit<ServiceConfig, "server"> & {
        server: Omit<ServiceConfig["server"], "port">;
      }
    > = {},
    options: { stableOrigin?: boolean } = {},
  ): Promise<SidecarTest> {
    return await acquire("sidecar fixture", async () => {
      const instance = new SidecarTest();
      const identity = crypto.randomUUID();
      if (options.stableOrigin) instance.#proxy = new FreezeProxy();
      const root = fromFileUrl(new URL("../../", import.meta.url));
      const overlay: Tree = {
        server: { port: 0 },
        auth: {
          type: "none",
          ...(instance.#proxy
            ? { cookiename: `otk_${instance.#proxy.port}` }
            : {}),
        },
        state: { path: join(oc.root, `otk-${identity}`) },
        harness: oc.kind === "opencode-v2-server"
          ? { type: "opencode-v2-server", db: oc.db }
          : { type: "opencode-v1", url: oc.url, db: oc.db },
      };
      // Overrides merge leaf-wise at every nesting level (the loader's own tree
      // merge), so naming one leaf keeps the fixture's other leaves.
      mergeLeafWise(overlay, overrides as unknown as Tree);
      // Let the production loader apply defaults and validate the overlay.
      const file = join(oc.root, `sidecar-${identity}.toml`);
      await Deno.writeTextFile(file, stringify(overlay));
      const config = loadServiceConfig({
        defaultsPath: join(root, "defaults/otk.toml"),
        overlayPath: file,
        env: {},
      }).config;
      instance.statePath = config.state.path;
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(Deno.env.toObject())) {
        if (!key.startsWith("OTK_")) env[key] = value;
      }
      env.OTK_CONFIG = file;
      Object.assign(env, oc.discoveryEnv ?? {});
      env.TMPDIR = join(oc.root, "tmp");
      // The listener announcement is an info diagnostic (not a test API).
      if (config.log.level === "warn") env.OTK_LOG_LEVEL = "info";
      const binary = Deno.env.get("OTK_TEST_BINARY");
      const args = [
        "run",
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run=git",
        "--allow-sys=systemMemoryInfo",
        "main.ts",
      ];
      const logDir = Deno.env.get("OTK_TEST_LOG_ROOT") ?? oc.root;
      instance.#launch = async () => {
        const owner = ownedProcess(
          binary ?? Deno.execPath(),
          binary ? [] : args,
          {
            cwd: root,
            env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        instance.process = owner.child;
        instance.#stopProcess = owner.stop;
        let logPath = join(logDir, `sidecar-${instance.port ?? identity}.log`);
        Deno.writeTextFileSync(logPath, "", { append: true });
        const log = (chunk: Uint8Array) => {
          const text = new TextDecoder().decode(chunk);
          instance.log += text;
          Deno.writeTextFileSync(logPath, text, { append: true });
        };
        instance.process.stdout!.on("data", log);
        instance.process.stderr!.on("data", log);
        try {
          const bound = await otkEndpoint(owner.child);
          instance.nativePort = Number(bound.port);
          instance.port = instance.#proxy?.port ?? instance.nativePort;
          instance.url = `http://127.0.0.1:${instance.port}`;
          const named = join(logDir, `sidecar-${instance.port}.log`);
          if (logPath !== named) {
            Deno.renameSync(logPath, named);
            logPath = named;
          }
          instance.#proxy?.retarget(instance.nativePort);
          await waitFor(
            async () =>
              (await fetch(instance.url + "/api/health", {
                signal: AbortSignal.timeout(5000),
              })).json(),
            (health) => health.ok === true,
          );
        } catch (error) {
          await instance.stop();
          throw new Error(`${error}\n${instance.log}`, { cause: error });
        }
      };
      await instance.#launch();
      return instance;
    });
  }
  async stop(): Promise<void> {
    try {
      await this.#proxy?.stop();
    } finally {
      await this.#stopProcess();
    }
  }
  async restart(between?: () => Promise<void>): Promise<void> {
    this.#proxy?.retarget();
    await this.#stopProcess();
    await between?.();
    await this.#launch();
  }
}
