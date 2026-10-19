// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapPart } from "../map.ts";
Deno.test("transcript mapping retains original image display sources without loading unrelated upload bytes into file metadata", () => {
  const raw = {
    id: "part",
    sessionID: "session",
    messageID: "message",
    type: "file",
    filename: "sample.png",
    mime: "image/png",
    url: "data:image/png;base64,AQID",
  };
  const image = mapPart(raw);
  assertEquals(image.kind === "file" && image.url, raw.url);
  const file = mapPart({
    ...raw,
    filename: "notes.txt",
    mime: "text/plain",
    url: "data:text/plain;base64,cHJpdmF0ZS1ieXRlcw==",
  });
  assertEquals(file.kind === "file" && file.name, "notes.txt");
  assertEquals(JSON.stringify(file).includes("cHJpdmF0ZS1ieXRlcw=="), false);
  const absent = mapPart({ ...raw, url: undefined });
  assertEquals(absent.kind === "file" && absent.url, undefined);
});
