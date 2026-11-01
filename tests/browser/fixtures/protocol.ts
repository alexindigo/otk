// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import {
  type Command,
  type Commands,
  type Profile,
  request,
  response,
  type StackInfo,
} from "../../support/fixture-control.ts";
import type { RpcMethod, RpcParams, RpcResult } from "@otk/protocol";

const exec = promisify(execFile);
export async function stopUnit(unit: string): Promise<void> {
  try {
    await exec("systemctl", ["--user", "stop", unit], { timeout: 15_000 });
  } catch (error) {
    if (!String((error as { stderr?: string }).stderr).includes("not loaded")) {
      throw error;
    }
  }
}
export { type Profile, type StackInfo };
export class Controller {
  readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  readonly unit: string;
  readonly root: string;
  child?: ChildProcessWithoutNullStreams;
  info?: StackInfo;
  log = "";
  #closed?: Promise<void>;
  #exit?: Promise<number | null>;
  constructor(readonly identity: string, readonly version: string) {
    const run = process.env.OTK_TEST_RUN;
    const root = process.env.OTK_TEST_RUN_ROOT;
    if (!run || !root) {
      throw new Error("Use deno task test:e2e (missing run ownership)");
    }
    this.unit = `${run}-${
      identity.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40)
    }-${randomUUID()}.service`;
    this.root = join(root, identity, randomUUID());
  }
  async start(profile: Profile = "ordinary"): Promise<this> {
    await mkdir(this.root, { recursive: true });
    await appendFile(
      process.env.OTK_TEST_UNIT_INVENTORY!,
      JSON.stringify({ unit: this.unit, root: this.root }) + "\n",
    );
    const environment = Object.entries(process.env).filter(([key, value]) =>
      value !== undefined && (
        key.startsWith("OTK_TEST_") ||
        ["PATH", "TMPDIR", "PLAYWRIGHT_BROWSERS_PATH", "DENO_DIR", "HOME"]
          .includes(key)
      )
    ).map(([key, value]) => `--setenv=${key}=${value}`);
    this.child = spawn("systemd-run", [
      "--user",
      "--pipe",
      "--wait",
      "--quiet",
      `--unit=${this.unit}`,
      "--property=KillMode=control-group",
      "--property=TimeoutStopSec=10s",
      `--working-directory=${join(process.cwd(), "../..")}`,
      ...environment,
      `--setenv=OTK_TEST_CONTROLLER_RECORD=${join(this.root, "owned.json")}`,
      `--setenv=OTK_TEST_STACK_ID=${process.env.OTK_TEST_RUN}-${this.identity}`,
      `--setenv=OTK_TEST_LOG_ROOT=${this.root}`,
      "deno",
      "run",
      "-A",
      "tests/support/fixture-controller.ts",
    ], { stdio: "pipe" });
    this.#exit = new Promise((resolve, reject) => {
      this.child!.once("error", reject);
      this.child!.once("close", (code) => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error(`Controller exited ${code}: ${this.log}`));
        }
        this.pending.clear();
        resolve(code);
      });
    });
    this.child.stderr.on("data", (bytes: Buffer) => {
      this.log = (this.log + bytes.toString()).slice(-65536);
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const frame = response(JSON.parse(line));
        const pending = this.pending.get(frame.id);
        if (!pending) {
          throw new Error(`Uncorrelated control response ${frame.id}`);
        }
        this.pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.result);
        else {pending.reject(
            new Error(frame.error!.message, { cause: frame.error }),
          );}
      } catch (error) {
        for (const p of this.pending.values()) p.reject(error as Error);
        this.pending.clear();
      }
    });
    try {
      this.info = await this.call<StackInfo>("start", {
        profile,
        version: this.version,
      }, 120_000);
      await writeFile(
        join(this.root, "stack.json"),
        JSON.stringify({ unit: this.unit, ...this.info }, null, 2),
      );
      return this;
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Controller startup and cleanup failed",
        );
      }
      throw error;
    }
  }
  async call<T = unknown>(
    command: Command,
    params: Commands[Command],
    timeout = 30_000,
  ): Promise<T> {
    const id = randomUUID();
    const frame = request({ v: 1, id, command, params });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Controller ${command} timed out`));
        }, timeout);
        this.child!.stdin.write(JSON.stringify(frame) + "\n", (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        });
      });
    } finally {
      clearTimeout(timer);
    }
  }
  rpc<M extends RpcMethod>(
    lease: string,
    method: M,
    params: RpcParams<M>,
  ): Promise<RpcResult<M>> {
    return this.call("productRpc", {
      lease,
      method,
      params: params as Commands["productRpc"]["params"],
    });
  }
  stop(): Promise<void> {
    return this.#closed ??= this.#stop();
  }
  async #stop(): Promise<void> {
    const errors: unknown[] = [];
    try {
      if (this.child && this.child.exitCode === null) {
        await this.call("stop", {}, 5000);
        this.child.stdin.end();
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await exec("systemctl", ["--user", "stop", this.unit], {
        timeout: 15_000,
      });
    } catch (error) {
      if (
        !String((error as { stderr?: string }).stderr).includes("not loaded")
      ) errors.push(error);
    }
    try {
      await expect.poll(async () => {
        try {
          const { stdout } = await exec("systemctl", [
            "--user",
            "show",
            this.unit,
            "--property=ControlGroup",
            "--value",
          ], { timeout: 5000 });
          const group = stdout.trim();
          if (!group) return true;
          try {
            await access(join("/sys/fs/cgroup", group));
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
            throw error;
          }
        } catch (error) {
          if (
            String((error as { stderr?: string }).stderr).includes("not found")
          ) return true;
          throw error;
        }
      }, { timeout: 15_000 }).toBe(true);
      if (this.#exit) {
        const code = await this.#exit;
        if (code !== 0) {
          errors.push(new Error(`Controller/unit exit ${code}: ${this.log}`));
        }
      }
      for (const pid of this.info?.pids ?? []) {
        await expect.poll(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
            throw error;
          }
        }, { timeout: 5000 }).toBe(true);
      }
    } catch (error) {
      errors.push(error);
    }
    await writeFile(join(this.root, "controller.log"), this.log);
    await writeFile(
      join(this.root, "cleanup.json"),
      JSON.stringify(
        { unit: this.unit, pids: this.info?.pids, errors: errors.map(String) },
        null,
        2,
      ),
    );
    if (errors.length) {
      throw new AggregateError(errors, "Controller cleanup failed");
    }
  }
  async evidence(): Promise<unknown> {
    return {
      unit: this.unit,
      stack: this.info,
      observation: await this.call("observe", {}),
      log: this.log,
    };
  }
}
export async function unitInventory(
  path: string,
): Promise<{ unit: string; root: string }[]> {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((
    line,
  ) => JSON.parse(line));
}
