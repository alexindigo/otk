// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { preparedBinary } from "../support/prepared-binaries.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { waitFor } from "../support/opencode.ts";
import { nativePrompt, selectedNative } from "../support/native-testing.ts";
import { resources, tempDir, test } from "../support/resources.ts";

test("compiled independent worker consumer digests off-source with empty runtime caches", async () => {
  const root = await tempDir("compiled-digest-");
  const binary = await preparedBinary("digest-consumer");
  const fake = new FakeLlm(), oc = await selectedNative(fake);
  const session = await oc.createSession("Compiled digest");
  const state = join(root, "state");
  const run = () => {
    const process = new Deno.Command(binary, {
      cwd: root,
      args: [
        state,
        oc.url,
        oc.db,
        session.id,
        oc.kind,
        oc.kind === "opencode-v2-server" ? oc.serviceFile : "",
      ],
      env: {
        DENO_DIR: join(root, `empty-cache-${crypto.randomUUID()}`),
        DENO_NO_REMOTE: "1",
        XDG_CACHE_HOME: join(root, "cache"),
        TMPDIR: Deno.env.get("TMPDIR")!,
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = process.stdin.getWriter();
    let error = "";
    const stderr = (async () => {
      for await (const chunk of process.stderr) {
        error += new TextDecoder().decode(chunk);
      }
    })();
    const rows: {
      delta: {
        summary: {
          state: string;
          messageCount?: number;
          total?: { calls: number };
        };
      };
    }[] = [];
    const stdout = (async () => {
      let buffer = "";
      for await (const chunk of process.stdout) {
        buffer += new TextDecoder().decode(chunk);
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"), line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.startsWith("{")) rows.push(JSON.parse(line));
        }
      }
    })();
    const stop = resources().defer("compiled digest consumer", async () => {
      await writer.write(new TextEncoder().encode("stop\n"));
      await writer.close();
      const status = await process.status;
      await Promise.all([stdout, stderr]);
      assertEquals(status.code, 0, error);
      assertEquals(
        /Download|Module not found|Cannot find/.test(error),
        false,
        error,
      );
    });
    return { rows, writer, stop };
  };
  const first = run();
  await waitFor(
    () => first.rows.at(-1),
    (row) => row?.delta.summary.state === "ready",
  );
  assertEquals(first.rows.at(-1)?.delta.summary.messageCount, 0);
  fake.queue({ chunks: ["Compiled worker reply"] });
  await nativePrompt(oc, session.id, "Compiled worker prompt");
  await first.writer.write(new TextEncoder().encode("changed\n"));
  await waitFor(
    () => first.rows.at(-1),
    (row) =>
      row?.delta.summary.state === "ready" &&
      (row.delta.summary.total?.calls ?? 0) > 0,
  );
  await first.stop();
  const second = run();
  await waitFor(
    () => second.rows.at(-1),
    (row) =>
      row?.delta.summary.state === "ready" &&
      (row.delta.summary.total?.calls ?? 0) > 0,
  );
  await second.stop();
});
