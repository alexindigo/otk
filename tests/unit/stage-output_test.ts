// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { runStage } from "../../scripts/tests/stage.ts";

const quiet = {
  stdout: { write: (bytes: Uint8Array) => Promise.resolve(bytes.length) },
  stderr: { write: (bytes: Uint8Array) => Promise.resolve(bytes.length) },
};

// Writes one-MiB lines alternately to stdout and stderr, then a last line.
const emitter = `
const line = (byte: number) => {
  const bytes = new Uint8Array(1 << 20).fill(byte);
  bytes[bytes.length - 1] = 10;
  return bytes;
};
const writeAll = async (sink: typeof Deno.stdout, bytes: Uint8Array) => {
  for (let at = 0; at < bytes.length;) at += await sink.write(bytes.subarray(at));
};
const [lines, last, exit] = Deno.args;
const out = line(111), err = line(101);
for (let i = 0; i < Number(lines); i++) {
  await writeAll(Deno.stdout, out);
  await writeAll(Deno.stderr, err);
}
await writeAll(Deno.stdout, new TextEncoder().encode(last + "\\n"));
Deno.exit(Number(exit));
`;

async function stage(lines: number, last: string, exit: number) {
  const dir = await Deno.makeTempDir();
  const script = join(dir, "emit.ts");
  await Deno.writeTextFile(script, emitter);
  const log = join(dir, "stage.log");
  const result = await runStage(
    Deno.execPath(),
    [
      "run",
      "--no-config",
      "--no-lock",
      script,
      String(lines),
      last,
      String(exit),
    ],
    log,
    { console: quiet },
  );
  return { dir, log, result };
}

Deno.test("a stage whose output exceeds one array still completes and keeps its log", async () => {
  // 160 MiB of stdout plus stderr is past V8's array length limit (about 128 Mi elements).
  const lines = 80;
  const { dir, log, result } = await stage(lines, "done", 0);
  try {
    assertEquals(result.code, 0);
    assert(result.success);
    assert(result.tail.split("\n").includes("done"));
    assert(result.tail.length <= 4 * (1 << 20));
    const counts = { o: 0, e: 0, done: 0 };
    let current = -1, length = 0, other = false;
    const file = await Deno.open(log);
    for await (const bytes of file.readable) {
      for (const byte of bytes) {
        if (byte === 10) {
          const whole = !other && length === (1 << 20) - 1;
          if (whole && current === 111) counts.o++;
          else if (whole && current === 101) counts.e++;
          else if (length === 4) counts.done++;
          current = -1;
          length = 0;
          other = false;
          continue;
        }
        if (current < 0) current = byte;
        else if (byte !== current) other = true;
        length++;
      }
    }
    // Every line of both streams is kept whole; stdout and stderr never split each other.
    assertEquals(counts, { o: lines, e: lines, done: 1 });
    assertEquals((await Deno.stat(log)).size, 2 * lines * (1 << 20) + 5);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failing stage reports its exit code and keeps its log", async () => {
  const { dir, log, result } = await stage(2, "failed", 3);
  try {
    assertEquals(result.code, 3);
    assert(!result.success);
    assert(result.tail.split("\n").includes("failed"));
    assertEquals((await Deno.stat(log)).size, 4 * (1 << 20) + 7);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
