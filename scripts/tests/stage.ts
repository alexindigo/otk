// SPDX-License-Identifier: LGPL-3.0-only
// One owner for test-stage output: it streams to the stage log and the console
// as it arrives, so memory never holds a stage's whole output. Readers that
// need a summary use the bounded tail; everything else reads the log.

export interface Sink {
  write(bytes: Uint8Array): Promise<number>;
}
export interface StageConsole {
  stdout: Sink;
  stderr: Sink;
}
export interface StageStreamOptions {
  console?: StageConsole;
  tailBytes?: number;
}
export interface StageOptions extends StageStreamOptions {
  env?: Record<string, string>;
  signal?: AbortSignal;
}

const tailLimit = 4 << 20;
// A longer line is written in pieces; until then each line is written whole,
// so stdout and stderr lines never split each other in the log.
const lineLimit = 64 << 20;

async function writeAll(sink: Sink, bytes: Uint8Array) {
  for (let at = 0; at < bytes.length;) {
    at += await sink.write(bytes.subarray(at));
  }
}

class Tail {
  #chunks: Uint8Array[] = [];
  #size = 0;
  #dropped = false;
  constructor(readonly limit: number) {}
  push(bytes: Uint8Array) {
    this.#chunks.push(bytes.slice());
    this.#size += bytes.length;
    while (this.#size - this.#chunks[0].length >= this.limit) {
      this.#size -= this.#chunks.shift()!.length;
      this.#dropped = true;
    }
  }
  text() {
    const all = new Uint8Array(this.#size);
    let at = 0;
    for (const chunk of this.#chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    let bytes = all.subarray(Math.max(0, all.length - this.limit));
    // A cut tail starts at its first whole line.
    if (this.#dropped || bytes.length < all.length) {
      bytes = bytes.subarray(bytes.indexOf(10) + 1 || bytes.length);
    }
    return new TextDecoder().decode(bytes);
  }
}

/** Streams a spawned stage's stdout and stderr into `log` and the console. */
export async function streamStage(
  child: Deno.ChildProcess,
  log: Sink,
  options: StageStreamOptions = {},
): Promise<{ status: Deno.CommandStatus; tail: string }> {
  const terminal = options.console ??
    { stdout: Deno.stdout, stderr: Deno.stderr };
  const tail = new Tail(options.tailBytes ?? tailLimit);
  let queue = Promise.resolve();
  const emit = (parts: Uint8Array[], sink: Sink) =>
    queue = queue.then(async () => {
      for (const part of parts) {
        await writeAll(log, part);
        tail.push(part);
      }
      for (const part of parts) await writeAll(sink, part);
    });
  const pump = async (stream: ReadableStream<Uint8Array>, sink: Sink) => {
    let pending: Uint8Array[] = [], size = 0;
    for await (const bytes of stream) {
      const end = bytes.lastIndexOf(10) + 1;
      if (end) {
        await emit([...pending, bytes.subarray(0, end)], sink);
        pending = [];
        size = 0;
      }
      if (end < bytes.length) {
        pending.push(bytes.subarray(end));
        size += bytes.length - end;
      }
      if (size > lineLimit) {
        await emit(pending, sink);
        pending = [];
        size = 0;
      }
    }
    if (pending.length) await emit(pending, sink);
  };
  try {
    const [status] = await Promise.all([
      child.status,
      pump(child.stdout, terminal.stdout),
      pump(child.stderr, terminal.stderr),
    ]);
    return { status, tail: tail.text() };
  } catch (error) {
    // A stage whose output can't be kept must not keep running unobserved.
    try {
      child.kill();
    } catch {
      // Already exited.
    }
    await child.status;
    throw error;
  }
}

/** Runs one stage, streaming its output to a new log file and the console. */
export async function runStage(
  command: string,
  args: string[],
  log: string,
  options: StageOptions = {},
) {
  const file = await Deno.open(log, { write: true, createNew: true });
  try {
    const child = new Deno.Command(command, {
      args,
      env: options.env,
      signal: options.signal,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const { status, tail } = await streamStage(child, file, options);
    return { code: status.code, success: status.success, tail };
  } finally {
    file.close();
  }
}
