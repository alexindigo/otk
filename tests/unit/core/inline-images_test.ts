// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { InlineImages } from "../../../core/files/inline-images.ts";
import { cfg } from "./support.ts";

Deno.test("inline image byte admission is FIFO, bounded and abortable", async () => {
  const issued: string[] = [];
  const readers = new Map<string, () => void>();
  const service = new InlineImages({
    directory: () => Promise.resolve("/fixture"),
    concurrency: 1,
    limits: { maxbytes: 1024, maxpixels: 1000 },
    files: {
      imageFacts: () => Promise.resolve([]),
      async imageBytes(_directory, path) {
        issued.push(path);
        await new Promise<void>((resolve) => readers.set(path, resolve));
        return { fact: { path, reason: "missing", status: "unavailable" } };
      },
    },
  });
  const get = (path: string, signal?: AbortSignal) =>
    service.response(
      new Request(
        `http://localhost/api/inline-image?session=tstv1-fixture&path=${path}`,
        { signal },
      ),
      cfg(),
    );
  const drain = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const cancel = new AbortController();
  const a = get("first"), b = get("retired", cancel.signal), c = get("last");
  const dismissed = assertRejects(() => b, DOMException, "aborted");
  await drain();
  assertEquals(issued, ["first"]);
  cancel.abort();
  await dismissed;
  readers.get("first")!();
  assertEquals(await (await a).text(), "Not found");
  await drain();
  assertEquals(issued, ["first", "last"]);
  readers.get("last")!();
  assertEquals((await c).status, 404);
});
