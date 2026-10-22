// SPDX-License-Identifier: LGPL-3.0-only
import type { ChildProcess } from "node:child_process";
import { fromFileUrl, join } from "@std/path";
import { stringify } from "@std/toml";
import { loadServiceConfig, type ServiceConfig } from "../../core/mod.ts";
import { freePort, type OpencodeTest, waitFor } from "./opencode.ts";
import { acquire } from "./resources.ts";
import { ownedProcess } from "./process.ts";
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export class SidecarTest {
  process!: ChildProcess;
  port!: number;
  url!: string;
  log = "";
  #stop: () => Promise<void> = () => Promise.resolve();
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
    oc: OpencodeTest,
    overrides: DeepPartial<ServiceConfig> = {},
  ): Promise<SidecarTest> {
    return await acquire("sidecar fixture", async () => {
      const instance = new SidecarTest();
      instance.port = await freePort();
      instance.url = `http://127.0.0.1:${instance.port}`;
      const root = fromFileUrl(new URL("../../", import.meta.url));
      const overlay = {
        server: { port: instance.port },
        auth: { type: "none" },
        state: { path: join(oc.root, `otk-${instance.port}`) },
        harness: { url: oc.url, db: oc.db },
        ...overrides,
      };
      // Let the production loader apply defaults and validate the overlay.
      const file = join(oc.root, `sidecar-${instance.port}.toml`);
      await Deno.writeTextFile(file, stringify(overlay));
      const config = loadServiceConfig({
        defaultsPath: join(root, "defaults/otk.toml"),
        overlayPath: file,
        env: {},
      }).config;
      instance.port = config.server.port;
      instance.url = `http://127.0.0.1:${instance.port}`;
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(Deno.env.toObject())) {
        if (!key.startsWith("OTK_")) env[key] = value;
      }
      env.OTK_CONFIG = file;
      env.TMPDIR = join(oc.root, "tmp");
      const owner = ownedProcess(Deno.execPath(), [
        "run",
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "main.ts",
      ], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      instance.process = owner.child;
      instance.#stop = owner.stop;
      instance.process.stdout!.on("data", (chunk) => {
        instance.log += chunk.toString();
      });
      instance.process.stderr!.on("data", (chunk) => {
        instance.log += chunk.toString();
      });
      try {
        await waitFor(
          async () =>
            (await fetch(instance.url + "/api/health", {
              signal: AbortSignal.timeout(5000),
            })).json(),
          (health) => health.ok === true,
        );
      } catch (error) {
        await instance.stop();
        throw new Error(`${error}\n${instance.log}`);
      }
      return instance;
    });
  }
  async stop(): Promise<void> {
    await this.#stop();
  }
}
