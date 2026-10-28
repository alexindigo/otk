// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { resources, tempDir, test } from "../support/resources.ts";

test("compiled independent worker consumer digests off-source with empty runtime caches", async () => {
  const root = await tempDir("compiled-digest-");
  const source = fromFileUrl(new URL("../../", import.meta.url));
  const binary = join(root, "digest-consumer");
  const build = await new Deno.Command(Deno.execPath(), {
    cwd: source,
    args: [
      "compile",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net=127.0.0.1",
      "--allow-sys=systemMemoryInfo",
      "--include",
      "packages/store/features/migrations",
      "--include",
      "core/digest/worker.ts",
      "--include",
      "packages/harness-opencode-v1/digest-migrations",
      "--output",
      binary,
      "tests/support/digest-consumer.ts",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!build.success) throw new Error(new TextDecoder().decode(build.stderr));
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const session = await oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Compiled digest" },
  });
  const state = join(root, "state");
  const run = () => {
    const process = new Deno.Command(binary, {
      cwd: root,
      args: [state, oc.url, oc.db, session.id],
      env: {
        DENO_DIR: join(root, `empty-cache-${crypto.randomUUID()}`),
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
  await oc.request(`/session/${session.id}/message`, {
    method: "POST",
    body: {
      model: { providerID: "fake", modelID: "scripted" },
      parts: [{ type: "text", text: "Compiled worker prompt" }],
    },
  });
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
