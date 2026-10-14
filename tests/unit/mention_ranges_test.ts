// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  mentionOptions,
  mentionQuery,
} from "../../web/src/ui/prompt/autocomplete.ts";
import { promptParts } from "../../sidecar/ws/prompt.ts";
import { mapPromptParts } from "@otk/harness-opencode1";
import { fixture } from "../support/config.ts";

Deno.test("TUI start-only, open and reversed mention ranges retain an optional end", () => {
  for (
    const [suffix, start, end] of [
      ["3", 3, undefined],
      ["3-", 3, undefined],
      ["20-10", 20, undefined],
      ["20-20", 20, undefined],
      ["10-20", 10, 20],
    ] as const
  ) {
    assertEquals<unknown>(mentionQuery(`src/file.ts#${suffix}`), {
      query: "src/file.ts",
      range: { start, ...(end === undefined ? {} : { end }) },
    });
  }
  assertEquals(mentionQuery("src/hash#file.ts#invalid"), {
    query: "src/hash#file.ts",
  });
});

Deno.test("optional mention end survives completion, RPC validation and actual harness URL mapping", async () => {
  const root = await fixture();
  await Deno.mkdir(join(root, "src"));
  await Deno.writeTextFile(
    join(root, "src/file.ts"),
    "line1\nline2\nline3\nline4\n",
  );
  for (const suffix of ["3", "3-", "20-10", "10-20"]) {
    const expectedStart = suffix.startsWith("20")
      ? "20"
      : suffix.startsWith("10")
      ? "10"
      : "3";
    const expectedEnd = suffix === "10-20" ? "20" : null;
    const option = mentionOptions({
      files: [{ path: "src/file.ts", directory: false }],
      agents: [],
      resources: [],
      frecency: [],
      directory: root,
    }, `src/file.ts#${suffix}`)[0];
    assert(option?.part);
    const mapped = await mapPromptParts(promptParts([option.part]), root);
    assert(mapped[0] && "url" in mapped[0]);
    const url = new URL(mapped[0].url!);
    assertEquals(url.searchParams.get("start"), expectedStart);
    assertEquals(
      url.searchParams.get("end"),
      expectedEnd,
      "Equal or fabricated end changes stock-harness symbol/range semantics",
    );
    assertEquals(
      option.label,
      `src/file.ts#${expectedStart}${expectedEnd ? `-${expectedEnd}` : ""}`,
    );
  }
});

Deno.test("start-only RPC input maps without manufacturing a matching end", async () => {
  const root = await fixture();
  await Deno.writeTextFile(join(root, "file.ts"), "one\ntwo\nthree\n");
  const mapped = await mapPromptParts(
    promptParts([{
      kind: "file",
      source: "path",
      path: "file.ts",
      range: { start: 3 },
    }]),
    root,
  );
  assert("url" in mapped[0]);
  assertEquals(new URL(mapped[0].url!).searchParams.get("end"), null);
});
