// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { DigestNativeDb, OpencodeV1Adapter } from "@otk/harness-opencode-v1";
import { fromFileUrl } from "@std/path";
import { cfg } from "../../../tests/support/config.ts";
import { test } from "../../../tests/support/resources.ts";

test("native identities project only fresh keyed facts without content enrichment", async () => {
  const calls: string[] = [];
  const adapter = new OpencodeV1Adapter(cfg(), undefined, (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path.endsWith("/missing")) {
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    if (path.endsWith("/offline")) return Promise.reject(new Error("offline"));
    return Promise.resolve(
      Response.json({
        id: path.split("/").at(-1),
        directory: "/fresh",
        parentID: "parent",
        revert: { messageID: "ignored" },
      }),
    );
  });
  try {
    assertEquals(
      await adapter.core.identities([
        "opcv1-a",
        "opcv1-b",
        "opcv1-a",
        "opcv1-missing",
      ]),
      [
        { id: "opcv1-a", directory: "/fresh", parentID: "opcv1-parent" },
        { id: "opcv1-b", directory: "/fresh", parentID: "opcv1-parent" },
      ],
    );
    assertEquals(calls, ["/session/a", "/session/b", "/session/missing"]);
    await assertRejects(() => adapter.core.identities(["opcv1-offline"]));
    const before = calls.length;
    await assertRejects(() => adapter.core.identities(["clcv1-a"]));
    assertEquals(await adapter.core.identities([]), []);
    assertEquals(calls.length, before);
  } finally {
    await adapter.core.stop();
  }
});

test("SQLite identity validation is one narrow set query with native parent_id and no history", () => {
  const operations: string[] = [];
  const db = new DigestNativeDb(
    fromFileUrl(
      new URL(
        "../../../tests/fixtures/opencode1/history-1.18.34-v4.db",
        import.meta.url,
      ),
    ),
    (op) => operations.push(op),
  );
  try {
    const sample = db.catalog("", 2);
    operations.length = 0;
    const result = db.identities(sample.map((s) => s.id));
    assertEquals(
      result,
      sample.map(({ id, directory, parentID }) => ({
        id,
        directory,
        ...(parentID ? { parentID } : {}),
      })),
    );
    assertEquals(operations, ["identities"]);
    assertEquals(db.identities([]), []);
    assertEquals(operations, ["identities"]);
  } finally {
    db.close();
  }
});
