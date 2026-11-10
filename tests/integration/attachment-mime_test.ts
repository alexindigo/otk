// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { mapPromptParts } from "@otk/harness-opencode-v1";
import { nativeFixture } from "../support/native-fixture.ts";
import { cfg } from "../support/config.ts";
import { v1NativeTests } from "../support/native-contract.ts";
const test = v1NativeTests(
  "V1 mapPromptParts MIME/file-URI pointers; V2 admits file bytes through native preparation",
  [
    "tests/integration/v2-actions_test.ts#OC2P3",
    "tests/integration/v2-catalogs_test.ts#OC2C2",
  ],
);

test("stock stores truthful path MIME and exact local URI identity without copying file bodies into the prompt", async () => {
  const f = await nativeFixture();
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Native MIME" },
    });
    const image = join(f.oc.directory, "pixel wrong.txt");
    await Deno.writeFile(
      image,
      Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
        ),
        (c) => c.charCodeAt(0),
      ),
    );
    await Deno.writeTextFile(
      join(f.oc.directory, "report.bin"),
      "%PDF-1.4\n%%EOF\n",
    );
    const parts = await mapPromptParts(
      [
        { kind: "text", text: "Native MIME smoke" },
        { kind: "file", source: "path", path: toFileUrl(image).href },
        { kind: "file", source: "path", path: "report.bin" },
      ],
      f.oc.directory,
      undefined,
      cfg().attachments,
    );
    assertEquals(parts.filter((p) => p.type === "file").map((p) => p.mime), [
      "image/png",
      "application/pdf",
    ]);
    assertEquals(
      parts.filter((p) => p.type === "file").every((p) =>
        p.url.startsWith("file:")
      ),
      true,
    );
    await f.oc.request(`/session/${session.id}/message`, {
      method: "POST",
      body: { noReply: true, parts },
    });
    const rows = await f.oc.request<
      { parts: { type: string; mime?: string; url?: string }[] }[]
    >(`/session/${session.id}/message`);
    assertEquals(
      rows.flatMap((row) => row.parts).filter((p) => p.type === "file").map((
        p,
      ) => p.mime),
      ["image/png", "application/pdf"],
    );
    await assertRejects(() =>
      mapPromptParts(
        [{
          kind: "file",
          source: "path",
          path: toFileUrl(image).href,
          range: { start: 1 },
        }],
        f.oc.directory,
        undefined,
        cfg().attachments,
      )
    );
  } finally {
    await f.stop();
  }
});
