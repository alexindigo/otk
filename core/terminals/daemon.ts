// SPDX-License-Identifier: LGPL-3.0-only
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join } from "@std/path";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { daemonEnvironment } from "./env.ts";
import {
  encodeRequest,
  type Frame,
  FrameDecoder,
  type Request,
  type Response,
} from "./frames.ts";

export interface DaemonOptions {
  binary: string;
  runtimeDir: string;
  handoffFile: string;
  systemd: boolean;
  environment: Readonly<Record<string, string>>;
  signal: AbortSignal;
}
export interface Registration {
  instance_id: string;
  pid: number;
  protocol: number;
  socket: string;
  token: string;
  features: string[];
}
export async function readRegistration(
  runtimeDir: string,
  name: string,
): Promise<Registration> {
  if (!/^otk-pty-[a-zA-Z0-9-]+$/.test(name)) {
    throw new Error("Invalid daemon name");
  }
  const value = JSON.parse(
    await Deno.readTextFile(join(runtimeDir, name, "service.json")),
  ) as Registration;
  if (value.protocol !== 8) {
    throw new Error("opencode-pty protocol mismatch (expected 8)");
  }
  if (
    !Number.isSafeInteger(value.pid) || value.pid <= 0 || !value.instance_id ||
    !value.token || !isAbsolute(value.socket) || !Array.isArray(value.features)
  ) throw new Error("Invalid daemon registration");
  return value;
}

/** A complete daemon rejection, distinct from a lost or malformed response. */
export class DaemonResponseError extends Error {}

/** Acquisition failed before a request could enter the transport. */
export class DaemonNotSentError extends Error {
  override name = "DaemonNotSentError";
  constructor(cause?: unknown) {
    super("Daemon request was not sent", { cause });
  }
}

export class DaemonConnection {
  #decoder = new FrameDecoder();
  #frames: Frame[] = [];
  #buffer = new Uint8Array(64 * 1024);
  #closed = false;
  private constructor(private conn: Deno.UnixConn) {}
  static async connect(path: string): Promise<DaemonConnection> {
    return new DaemonConnection(
      await Deno.connect({ transport: "unix", path }),
    );
  }
  async send(token: string, request: Request): Promise<void> {
    const bytes = encodeRequest(token, request);
    let offset = 0;
    while (offset < bytes.length) {
      offset += await this.conn.write(bytes.subarray(offset));
    }
  }
  async next(): Promise<Frame | null> {
    while (!this.#frames.length) {
      const count = await this.conn.read(this.#buffer);
      if (count === null) {
        this.#decoder.finish();
        return null;
      }
      this.#frames.push(...this.#decoder.push(this.#buffer.subarray(0, count)));
    }
    return this.#frames.shift()!;
  }
  async response(): Promise<Response> {
    const frame = await this.next();
    if (!frame || frame.kind !== "json") {
      throw new Error("Expected daemon JSON response");
    }
    if (frame.value.type === "error") {
      throw new DaemonResponseError(frame.value.message);
    }
    return frame.value;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.conn.close();
  }
}
async function bounded<T>(
  connection: DaemonConnection,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const cancel = () => connection.close();
  const timer = setTimeout(cancel, 5000);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    return await action();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
async function removeMissingOK(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
export interface Handoff {
  name: string;
  runtimeDir: string;
  ticket: string;
  expiresAt: number;
}
export async function readHandoff(
  o: Pick<DaemonOptions, "handoffFile" | "runtimeDir">,
): Promise<Handoff | undefined> {
  try {
    const value = JSON.parse(await Deno.readTextFile(o.handoffFile)) as Handoff;
    if (
      !value || typeof value !== "object" ||
      value.runtimeDir !== o.runtimeDir ||
      !/^otk-pty-[a-zA-Z0-9-]+$/.test(value.name) ||
      typeof value.ticket !== "string" ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
    ) {
      await removeMissingOK(o.handoffFile);
      return undefined;
    }
    return value;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    if (error instanceof SyntaxError) {
      await removeMissingOK(o.handoffFile);
      return undefined;
    }
    throw error;
  }
}

/** Fresh UUID/unit per attempt; unowned daemons enforce their own 5 s cleanup. */
export async function spawnDaemon(
  o: Omit<DaemonOptions, "handoffFile" | "signal">,
  name: string,
): Promise<void> {
  const args = ["daemon", "--runtime-dir", o.runtimeDir, "--name", name];
  const env = daemonEnvironment(o.environment);
  if (o.systemd) {
    const result = await new Deno.Command("systemd-run", {
      args: [
        "--user",
        "--collect",
        "--quiet",
        `--unit=${name}`,
        "--property=KillMode=control-group",
        "--",
        "/usr/bin/env",
        "-i",
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        o.binary,
        ...args,
      ],
      clearEnv: true,
      env: {
        ...env,
        ...(o.environment.DBUS_SESSION_BUS_ADDRESS
          ? { DBUS_SESSION_BUS_ADDRESS: o.environment.DBUS_SESSION_BUS_ADDRESS }
          : {}),
      },
      signal: AbortSignal.timeout(5000),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    if (!result.success) {
      throw new Error("systemd-run failed to start opencode-pty");
    }
  } else {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(o.binary, args, {
        detached: true,
        stdio: "ignore",
        env,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}
type Job = {
  request: Request;
  settle: { resolve: (v: Response) => void; reject: (e: unknown) => void }[];
};

export class PtyDaemon {
  readonly closed: Promise<void>;
  #finish!: () => void;
  #alive = true;
  #connections = new Set<DaemonConnection>();
  #queues = new Map<number, Job[]>();
  #ownerReply?: {
    resolve: (v: Response) => void;
    reject: (e: unknown) => void;
  };
  #ownerSerial: Promise<unknown> = Promise.resolve();
  #handoff?: Promise<void>;
  private constructor(
    readonly name: string,
    private registration: Registration,
    private owner: DaemonConnection,
    private options: DaemonOptions,
  ) {
    this.closed = new Promise((resolve) => this.#finish = resolve);
    void this.#monitor();
  }
  get pid(): number {
    return this.registration.pid;
  }
  get alive(): boolean {
    return this.#alive;
  }
  get registrationFile(): string {
    return join(this.options.runtimeDir, this.name, "service.json");
  }

  static async start(o: DaemonOptions): Promise<PtyDaemon> {
    o.signal.throwIfAborted();
    for (const path of [dirname(o.handoffFile), o.runtimeDir]) {
      await Deno.mkdir(path, { recursive: true, mode: 0o700 });
      await Deno.chmod(path, 0o700);
    }
    const inherited = await readHandoff(o);
    if (inherited) {
      try {
        const daemon = await this.#claim(o, inherited.name, inherited.ticket);
        try {
          await removeMissingOK(o.handoffFile);
        } catch (error) {
          await daemon.shutdown();
          throw error;
        }
        return daemon;
      } catch {
        o.signal.throwIfAborted();
        await removeMissingOK(o.handoffFile);
      }
    }
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      o.signal.throwIfAborted();
      const name = `otk-pty-${crypto.randomUUID()}`;
      try {
        await spawnDaemon(o, name);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          o.signal.throwIfAborted();
          try {
            await readRegistration(o.runtimeDir, name);
            break;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        return await this.#claim(o, name, null);
      } catch (error) {
        failure = error;
      }
    }
    throw new Error("opencode-pty unavailable after two start attempts", {
      cause: failure,
    });
  }
  static async #claim(
    o: DaemonOptions,
    name: string,
    ticket: string | null,
  ): Promise<PtyDaemon> {
    const registration = await readRegistration(o.runtimeDir, name);
    const conn = await DaemonConnection.connect(registration.socket);
    try {
      const reply = await bounded(conn, async () => {
        await conn.send(registration.token, {
          op: "own",
          instance_id: registration.instance_id,
          ticket,
        });
        return await conn.response();
      }, o.signal);
      if (reply.type !== "owned") throw new Error("Daemon refused ownership");
      o.signal.throwIfAborted();
      return new PtyDaemon(name, registration, conn, o);
    } catch (error) {
      conn.close();
      throw error;
    }
  }
  async #monitor(): Promise<void> {
    try {
      while (true) {
        const frame = await this.owner.next();
        if (frame === null) break;
        if (frame.kind !== "json" || !this.#ownerReply) {
          throw new Error("Unexpected owner frame");
        }
        const reply = this.#ownerReply;
        this.#ownerReply = undefined;
        if (frame.value.type === "error") {
          reply.reject(new DaemonResponseError(frame.value.message));
        } else reply.resolve(frame.value);
      }
    } catch {
      /* Owner loss is represented by closed, never a detached rejection. */
    } finally {
      this.#alive = false;
      this.owner.close();
      this.#ownerReply?.reject(new Error("Daemon owner disconnected"));
      this.#ownerReply = undefined;
      for (const conn of this.#connections) conn.close();
      this.#connections.clear();
      this.#finish();
    }
  }
  #ownerRequest(request: Request): Promise<Response> {
    const work = this.#ownerSerial.then(() =>
      bounded(this.owner, async () => {
        if (!this.alive) throw new Error("Daemon owner disconnected");
        const reply = new Promise<Response>((resolve, reject) =>
          this.#ownerReply = { resolve, reject }
        );
        // Owner loss can reject while its write is still outstanding.
        void reply.catch(() => {});
        try {
          await this.owner.send(this.registration.token, request);
        } catch (error) {
          this.#ownerReply?.reject(error);
          this.#ownerReply = undefined;
        }
        return await reply;
      })
    );
    this.#ownerSerial = work.catch(() => {});
    return work;
  }
  async #acquire(): Promise<DaemonConnection> {
    let conn: DaemonConnection | undefined;
    try {
      if (!this.alive) throw new Error("Daemon is gone");
      conn = await DaemonConnection.connect(this.registration.socket);
      if (!this.alive) throw new Error("Daemon is gone");
    } catch (cause) {
      conn?.close();
      throw new DaemonNotSentError(cause);
    }
    // Register before yielding, so owner retirement sees every acquired socket.
    this.#connections.add(conn);
    return conn;
  }
  async #oneShot(request: Request): Promise<Response> {
    const conn = await this.#acquire();
    try {
      return await bounded(conn, async () => {
        if (!this.alive) throw new DaemonNotSentError();
        await conn.send(this.registration.token, request);
        return await conn.response();
      });
    } finally {
      conn.close();
      this.#connections.delete(conn);
    }
  }
  request(request: Request): Promise<Response> {
    if (!("id" in request)) return this.#oneShot(request);
    const id = request.id;
    if (
      request.op === "input" && decodeBase64(request.data_base64).length > 65536
    ) return Promise.reject(new Error("Input exceeds 64 KiB"));
    return new Promise((resolve, reject) => {
      const existing = this.#queues.get(id);
      if (existing) {
        const tail = existing.at(-1);
        if (
          request.op === "input" && tail?.request.op === "input" &&
          tail.request.attachment_id === request.attachment_id &&
          tail.request.cols === request.cols &&
          tail.request.rows === request.rows
        ) {
          const a = decodeBase64(tail.request.data_base64),
            b = decodeBase64(request.data_base64);
          if (a.length + b.length <= 65536) {
            const bytes = new Uint8Array(a.length + b.length);
            bytes.set(a);
            bytes.set(b, a.length);
            tail.request = {
              ...tail.request,
              data_base64: encodeBase64(bytes),
            };
            tail.settle.push({ resolve, reject });
            return;
          }
        }
        existing.push({ request, settle: [{ resolve, reject }] });
      } else {
        const queue = [{ request, settle: [{ resolve, reject }] }];
        this.#queues.set(id, queue);
        void this.#drain(id, queue);
      }
    });
  }
  async #drain(id: number, queue: Job[]): Promise<void> {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        const reply = await this.#oneShot(job.request);
        for (const s of job.settle) s.resolve(reply);
      } catch (error) {
        for (const s of job.settle) s.reject(error);
      }
    }
    this.#queues.delete(id);
  }
  async subscribe(
    request: Extract<Request, { op: "subscribe" }>,
  ): Promise<DaemonConnection> {
    const conn = await this.#acquire();
    try {
      if (!this.alive) throw new DaemonNotSentError();
      await bounded(conn, () => conn.send(this.registration.token, request));
      if (!this.alive) throw new Error("Daemon owner disconnected");
      return conn;
    } catch (error) {
      this.release(conn);
      throw error;
    }
  }
  release(conn: DaemonConnection): void {
    conn.close();
    this.#connections.delete(conn);
  }
  handoff(): Promise<void> {
    return this.#handoff ??= this.#handoffNow();
  }
  async #handoffNow(): Promise<void> {
    if (!this.alive) return;
    try {
      const response = await this.#ownerRequest({ op: "prepare_handoff" });
      if (response.type !== "handoff") {
        throw new Error("Expected daemon handoff");
      }
      const dest = this.options.handoffFile,
        tmp = `${dest}.${crypto.randomUUID()}.tmp`;
      try {
        await Deno.writeTextFile(
          tmp,
          JSON.stringify({
            name: this.name,
            runtimeDir: this.options.runtimeDir,
            ticket: response.ticket,
            expiresAt: response.expires_at,
          }),
          { createNew: true, mode: 0o600 },
        );
        await Deno.rename(tmp, dest);
      } finally {
        await removeMissingOK(tmp);
      }
    } catch (error) {
      // Publication is part of the owner's transfer, not the caller's cleanup.
      // A failed transfer must not retain a live owner and keep OTK running.
      try {
        await this.shutdown();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Daemon handoff and shutdown failed",
        );
      }
      throw error;
    } finally {
      this.owner.close();
      await this.closed;
    }
  }
  async shutdown(): Promise<void> {
    try {
      if (this.alive) await this.#ownerRequest({ op: "shutdown" });
    } finally {
      this.owner.close();
      await this.closed;
    }
  }
  async disconnect(): Promise<void> {
    this.owner.close();
    await this.closed;
  }
}
