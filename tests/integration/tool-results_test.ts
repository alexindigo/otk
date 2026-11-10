// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { mapTool, type RawPart } from "@otk/harness-opencode-v1";
import { nativeFixture } from "../support/native-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { v1NativeTests } from "../support/native-contract.ts";
const test = v1NativeTests("V1 read tool offset/limit and RawPart mapping", [
  "tests/integration/v2-transcripts_test.ts#OC2T4",
]);

test("stock read empty pages preserve real offset, zero-limit totals and source bytes", async () => {
  const f = await nativeFixture({ read: "allow" }, {
    prepare: async (oc) => {
      await Deno.mkdir(join(oc.directory, "src"));
      await Deno.writeTextFile(join(oc.directory, "src/only.txt"), "only\n");
    },
  });
  f.fake.strict();
  const session = await f.oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Real empty read pages" },
  });
  const read = async (input: Record<string, unknown>) => {
    const previous = await f.oc.request<{ parts: RawPart[] }[]>(
      `/session/${session.id}/message`,
    );
    const ids = new Set(
      previous.flatMap((message) => message.parts).map((part) => part.id),
    );
    f.fake.queue({ tool: { name: "read", input } }, {
      chunks: ["Read page complete."],
    });
    await f.oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Read the characterized page" }] },
    });
    const messages = await waitFor(
      () =>
        f.oc.request<
          {
            info: {
              role: string;
              finish?: string;
              time: { completed?: number };
            };
            parts: RawPart[];
          }[]
        >(`/session/${session.id}/message`),
      (rows) =>
        rows.some((row) =>
          row.parts.some((part) =>
            !ids.has(part.id) && part.type === "tool" &&
            part.state?.status === "completed"
          )
        ) && rows.some((row) =>
          row.info.role === "assistant" && row.info.finish === "stop" &&
          !!row.info.time.completed && row.parts.some((part) =>
            !ids.has(part.id) && part.type === "text" &&
            part.text === "Read page complete."
          )
        ) && f.fake.active === 0,
    );
    const raw = messages.flatMap((message) => message.parts).find((part) =>
      !ids.has(part.id) && part.type === "tool" &&
      part.state?.status === "completed"
    )!;
    assert(raw.state?.output !== undefined);
    return mapTool(raw).outputContent;
  };
  assertEquals(
    await read({ filePath: join(f.oc.directory, "src"), offset: 3 }),
    { kind: "paths", paths: [], offset: 3, total: 1, truncated: false },
  );
  assertEquals(
    await read({ filePath: join(f.oc.directory, "src/only.txt"), limit: 0 }),
    {
      kind: "file",
      text: "",
      lang: "txt",
      startLine: 1,
      endLine: 0,
      totalLines: 1,
      truncated: true,
    },
  );
  assertEquals(
    await Deno.readTextFile(join(f.oc.directory, "src/only.txt")),
    "only\n",
  );
  assertEquals(f.fake.pending, 0);
  assertEquals(f.fake.unexpected, 0);
});
