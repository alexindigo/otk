// SPDX-License-Identifier: LGPL-3.0-only
import { resources } from "./resources.ts";
/** A byte-transparent TCP proxy: freezing stalls traffic without closing sockets. */
export class FreezeProxy {
  #listener: Deno.TcpListener;
  #connections = new Set<Deno.TcpConn>();
  #jobs = new Set<Promise<void>>();
  #accept: Promise<void>;
  #frozen = false;
  #stopping = false;
  #failures: unknown[] = [];
  #waiters: (() => void)[] = [];
  readonly port: number;
  #stop: () => Promise<void>;
  constructor(readonly target: number) {
    const scope = resources();
    this.#listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    this.port = (this.#listener.addr as Deno.NetAddr).port;
    this.#accept = this.#run().catch((error) => {
      this.#failures.push(error);
    });
    this.#stop = scope.defer("freeze proxy", () => this.#shutdown());
  }
  freeze(): void {
    this.#frozen = true;
  }
  thaw(): void {
    this.#frozen = false;
    for (const wake of this.#waiters.splice(0)) wake();
  }
  async #run(): Promise<void> {
    try {
      for await (const incoming of this.#listener) {
        const task = this.#pair(incoming).catch((error) => {
          this.#failures.push(error);
        });
        this.#jobs.add(task);
        void task.then(() => this.#jobs.delete(task));
      }
    } catch (error) {
      if (!this.#stopping || !(error instanceof Deno.errors.BadResource)) {
        throw error;
      }
    }
  }
  async #pair(incoming: Deno.TcpConn): Promise<void> {
    this.#connections.add(incoming);
    let outgoing: Deno.TcpConn | undefined;
    try {
      outgoing = await Deno.connect({
        hostname: "127.0.0.1",
        port: this.target,
      });
      this.#connections.add(outgoing);
      if (this.#stopping) return;
      let closing = false;
      const forward = async (
        source: Deno.TcpConn,
        target: Deno.TcpConn,
      ) => {
        const buffer = new Uint8Array(65_536);
        try {
          while (true) {
            const size = await source.read(buffer);
            if (size === null) break;
            while (this.#frozen) {
              await new Promise<void>((resolve) => this.#waiters.push(resolve));
            }
            let written = 0;
            while (written < size) {
              const count = await target.write(buffer.subarray(written, size));
              if (!count) throw new Error("Proxy write made no progress");
              written += count;
            }
          }
        } catch (error) {
          if (
            !((this.#stopping || closing) &&
              (error instanceof Deno.errors.BadResource ||
                error instanceof Deno.errors.Interrupted))
          ) throw error;
        } finally {
          closing = true;
          try {
            target.close();
          } catch { /* peer already closed */ }
        }
      };
      const results = await Promise.allSettled([
        forward(incoming, outgoing),
        forward(outgoing, incoming),
      ]);
      for (const result of results) {
        if (result.status === "rejected") this.#failures.push(result.reason);
      }
    } finally {
      for (const socket of [incoming, outgoing]) {
        if (socket) {
          this.#connections.delete(socket);
          try {
            socket.close();
          } catch { /* already closed */ }
        }
      }
    }
  }
  async stop(): Promise<void> {
    await this.#stop();
  }
  async #shutdown(): Promise<void> {
    this.#stopping = true;
    this.thaw();
    this.#listener.close();
    for (const socket of this.#connections) {
      try {
        socket.close();
      } catch { /* already closed */ }
    }
    await this.#accept;
    await Promise.allSettled([...this.#jobs]);
    if (this.#failures.length) {
      throw new AggregateError(
        this.#failures,
        "Unexpected freeze proxy forwarding failure",
      );
    }
  }
}
