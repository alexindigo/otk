// SPDX-License-Identifier: LGPL-3.0-only
/** A byte-transparent TCP proxy: freezing stalls traffic without closing sockets. */
export class FreezeProxy {
  #listener: Deno.TcpListener;
  #connections = new Set<Deno.TcpConn>();
  #jobs = new Set<Promise<void>>();
  #accept: Promise<void>;
  #frozen = false;
  #waiters: (() => void)[] = [];
  readonly requests: string[] = [];
  readonly port: number;
  constructor(readonly target: number) {
    this.#listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    this.port = (this.#listener.addr as Deno.NetAddr).port;
    this.#accept = this.#run();
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
        const task = this.#pair(incoming);
        this.#jobs.add(task);
        task.finally(() => this.#jobs.delete(task));
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
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
      const forward = async (
        source: Deno.TcpConn,
        target: Deno.TcpConn,
        record = false,
      ) => {
        const buffer = new Uint8Array(65_536);
        let header = "", recorded = false;
        try {
          while (true) {
            const size = await source.read(buffer);
            if (size === null) break;
            if (record && !recorded) {
              header += new TextDecoder().decode(buffer.subarray(0, size));
              if (header.includes("\r\n")) {
                this.requests.push(header.split("\r\n")[0]);
                recorded = true;
                header = "";
              }
            }
            while (this.#frozen) {
              await new Promise<void>((resolve) => this.#waiters.push(resolve));
            }
            let written = 0;
            while (written < size) {
              written += await target.write(buffer.subarray(written, size));
            }
          }
        } finally {
          try {
            target.close();
          } catch { /* peer already closed */ }
        }
      };
      await Promise.allSettled([
        forward(incoming, outgoing, true),
        forward(outgoing, incoming),
      ]);
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
    this.thaw();
    this.#listener.close();
    for (const socket of this.#connections) {
      try {
        socket.close();
      } catch { /* already closed */ }
    }
    await this.#accept;
    await Promise.allSettled([...this.#jobs]);
  }
}
