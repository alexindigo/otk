// SPDX-License-Identifier: LGPL-3.0-only
import { tempDir, test } from "../../../tests/support/resources.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { HarnessError } from "@otk/harness";
import type { PromptPart } from "@otk/protocol";
import { Client } from "../client.ts";
import { commands } from "../commands.ts";
import { prompt } from "../prompt.ts";
import { cfg } from "../../../tests/support/config.ts";

for (const mode of ["prompt", "command"] as const) {
  for (
    const fault of [
      "missing",
      "parent denied",
      "file denied",
      "directory denied",
      "broken link",
    ] as const
  ) {
    test(`${mode} rejects the entire send for an explicit ${fault} attachment before native admission`, async () => {
      const root = await tempDir("otk-required-");
      const blocked = join(root, "blocked"), selected = "blocked/selected.txt";
      await Deno.mkdir(blocked);
      await Deno.writeTextFile(
        join(root, "good.txt"),
        "retained good attachment",
      );
      await Deno.writeTextFile(join(root, selected), "selected bytes");
      if (fault === "missing") await Deno.remove(join(root, selected));
      if (fault === "parent denied") await Deno.chmod(blocked, 0);
      if (fault === "file denied") await Deno.chmod(join(root, selected), 0);
      if (fault === "directory denied") await Deno.chmod(blocked, 0);
      if (fault === "broken link") {
        await Deno.remove(join(root, selected));
        await Deno.symlink(join(root, "absent.txt"), join(root, selected));
      }
      const path = fault === "directory denied" ? "blocked" : selected;
      const parts: PromptPart[] = [
        { kind: "text", text: "keep the whole draft" },
        { kind: "file", source: "path", path: "good.txt" },
        { kind: "file", source: "path", path },
        {
          kind: "file",
          source: "upload",
          name: "upload.txt",
          mime: "text/plain",
          dataBase64: btoa("upload bytes"),
        },
      ];
      const original = structuredClone(parts);
      const writes: unknown[] = [];
      const client = new Client(cfg().harness, (_input, options) => {
        writes.push(options?.body);
        return Promise.resolve(new Response(null, { status: 204 }));
      });
      const directory = {
        cached: () => root,
        resolve: () => Promise.resolve(root),
      };
      const send = mode === "prompt"
        ? () =>
          prompt(client, directory, () => {}).prompt({
            sessionID: "session",
            mode: "normal",
            parts,
          })
        : () =>
          commands(client, directory, (...args) => {
            writes.push(args);
          }).command({
            sessionID: "session",
            command: "probe",
            arguments: "keep",
            parts: parts.filter((part) => part.kind === "file"),
          });
      try {
        await assertRejects(
          send,
          HarnessError,
          `Cannot read attachment "${path}"`,
        );
        assertEquals(
          writes,
          [],
          "An incomplete send reached the native request/admission owner",
        );
        assertEquals(
          parts,
          original,
          "Resolution mutated the originating attachments",
        );
      } finally {
        await Deno.chmod(blocked, 0o700);
        if (fault === "file denied") {
          await Deno.chmod(join(root, selected), 0o600);
        }
        await Deno.remove(root, { recursive: true });
      }
    });
  }
}

test("required attachment mapping preserves every source, order, directory and range", async () => {
  const root = await tempDir("otk-required-valid-");
  await Deno.mkdir(join(root, "docs"));
  await Deno.writeTextFile(join(root, "notes.txt"), "one\ntwo\nthree");
  const writes: unknown[] = [];
  const client = new Client(cfg().harness, (_input, options) => {
    writes.push(JSON.parse(String(options?.body)));
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const directory = {
    cached: () => root,
    resolve: () => Promise.resolve(root),
  };
  const parts: PromptPart[] = [
    { kind: "text", text: "all parts" },
    { kind: "agent", name: "explore" },
    {
      kind: "file",
      source: "path",
      path: "./notes.txt",
      range: { start: 2, end: 3 },
    },
    { kind: "file", source: "path", path: join(root, "docs") },
    {
      kind: "file",
      source: "upload",
      name: "upload.txt",
      mime: "text/plain",
      dataBase64: "AQID",
    },
    {
      kind: "file",
      source: "resource",
      name: "spec",
      mime: "text/plain",
      server: "fixture",
      uri: "fixture://spec",
    },
  ];
  try {
    await prompt(client, directory, () => {}).prompt({
      sessionID: "session",
      mode: "normal",
      parts,
    });
    const mapped = [
      { type: "text", text: "all parts" },
      { type: "agent", name: "explore" },
      {
        type: "file",
        filename: "notes.txt#2-3",
        mime: "text/plain",
        url: `${toFileUrl(join(root, "notes.txt"))}?start=2&end=3`,
      },
      {
        type: "file",
        filename: "docs",
        mime: "application/x-directory",
        url: toFileUrl(join(root, "docs")).href,
      },
      {
        type: "file",
        filename: "upload.txt",
        mime: "text/plain",
        url: "data:text/plain;base64,AQID",
      },
      {
        type: "file",
        filename: "spec",
        mime: "text/plain",
        url: "fixture://spec",
        source: {
          type: "resource",
          clientName: "fixture",
          uri: "fixture://spec",
          text: { start: 0, end: 5, value: "@spec" },
        },
      },
    ];
    assertEquals(writes, [{ parts: mapped }]);
    await commands(client, directory, (_id, _operation, _path, options) => {
      writes.push(options?.body);
    }).command({
      sessionID: "session",
      command: "probe",
      arguments: "args",
      parts: parts.filter((part) => part.kind === "file"),
    });
    assertEquals(writes[1], {
      command: "probe",
      arguments: "args",
      agent: undefined,
      variant: undefined,
      model: undefined,
      parts: mapped.slice(2),
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
