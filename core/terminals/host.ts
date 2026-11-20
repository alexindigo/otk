// SPDX-License-Identifier: LGPL-3.0-only
import { isAbsolute, join } from "@std/path";
import { embeddedPtyBinary, resolvePtyBinary } from "./binary.ts";
import { PtyDaemon, readHandoff } from "./daemon.ts";
import { hasSystemd, shellEnvironment, shellProgram } from "./env.ts";
import type { ProcessInfo } from "./frames.ts";

export class TerminalUnavailable extends Error {
  readonly code = "terminal-unavailable";
  constructor(cause?: unknown) {
    super("Terminal service unavailable", { cause });
  }
}
export interface TerminalHostOptions {
  statePath: string;
  dataDir: string;
  environment: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

/** One lazy daemon owner per server; application composition owns this lifetime. */
export class TerminalHost {
  #daemon?: PtyDaemon;
  #starting?: Promise<PtyDaemon>;
  #stop?: Promise<void>;
  #stopped = false;
  #gone = new Set<() => void>();
  #environment: Readonly<Record<string, string>>;
  readonly runtimeDir: string;
  readonly handoffFile: string;
  unavailable?: TerminalUnavailable;
  private constructor(private options: TerminalHostOptions) {
    this.#environment = Object.freeze({ ...options.environment });
    this.runtimeDir = join(options.statePath, "terminals", "pty");
    this.handoffFile = join(options.statePath, "terminals", "handoff.json");
  }
  static async start(options: TerminalHostOptions): Promise<TerminalHost> {
    const host = new TerminalHost(options);
    try {
      if (await readHandoff(host)) await host.daemon();
    } catch (cause) {
      host.unavailable = new TerminalUnavailable(cause);
    }
    return host;
  }
  onGone(listener: () => void): () => void {
    this.#gone.add(listener);
    return () => this.#gone.delete(listener);
  }
  daemon(): Promise<PtyDaemon> {
    if (this.#stopped) return Promise.reject(new TerminalUnavailable());
    if (this.#daemon?.alive) return Promise.resolve(this.#daemon);
    if (this.#starting) return this.#starting;
    const work = this.#startDaemon();
    this.#starting = work;
    void work.finally(() => {
      if (this.#starting === work) this.#starting = undefined;
    }).catch(() => {});
    return work;
  }
  async #startDaemon(): Promise<PtyDaemon> {
    try {
      const env = this.#environment;
      const binary = await resolvePtyBinary(
        this.options.dataDir,
        embeddedPtyBinary(),
        env.OTK_PTY_BIN,
      );
      const daemon = await PtyDaemon.start({
        binary,
        runtimeDir: this.runtimeDir,
        handoffFile: this.handoffFile,
        environment: env,
        systemd: await hasSystemd(env),
        signal: this.options.signal,
      });
      this.#daemon = daemon;
      this.unavailable = undefined;
      void daemon.closed.then(() => {
        if (this.#daemon !== daemon) return;
        this.#daemon = undefined;
        if (!this.#stopped) { for (const listener of this.#gone) listener(); }
      });
      return daemon;
    } catch (cause) {
      throw this.unavailable = new TerminalUnavailable(cause);
    }
  }
  async list(sessionID: string): Promise<ProcessInfo[]> {
    const daemon = await this.daemon();
    if (this.#stopped) throw new TerminalUnavailable();
    const reply = await daemon.request({ op: "list", mode: "pty" });
    if (reply.type !== "processes") {
      throw new Error("Expected daemon process list");
    }
    return reply.processes.filter((terminal) =>
      terminal.group_id === sessionID
    );
  }
  async create(
    sessionID: string,
    cwd: string,
    cols: number,
    rows: number,
  ): Promise<ProcessInfo> {
    if (!isAbsolute(cwd)) {
      throw new Error("Terminal working directory must be absolute");
    }
    const program = await shellProgram(this.#environment);
    const daemon = await this.daemon();
    if (this.#stopped) throw new TerminalUnavailable();
    const reply = await daemon.request({
      op: "create_pty",
      program,
      args: ["-l"],
      cwd,
      cols,
      rows,
      env: shellEnvironment(this.#environment),
      group_id: sessionID,
      title: program.split("/").at(-1) || "Shell",
    });
    if (reply.type !== "created") throw new Error("Expected created terminal");
    return reply.process;
  }
  async close(sessionID: string, id: number): Promise<void> {
    const daemon = await this.daemon();
    const reply = await daemon.request({ op: "get", id });
    if (reply.type !== "process" || reply.process.group_id !== sessionID) {
      throw new Error("Terminal not found");
    }
    await daemon.request({ op: "terminate", id });
  }
  stop(): Promise<void> {
    this.#stopped = true;
    return this.#stop ??= (async () => {
      try {
        await this.#starting;
      } catch { /* Failed acquisition has no owner to hand off. */ }
      if (this.#daemon?.alive) await this.#daemon.handoff();
      this.#gone.clear();
    })();
  }
}
