// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { cfg, fixture } from "../support/config.ts";
import { OtkDb } from "../../sidecar/db/db.ts";
import { Prefs } from "../../sidecar/db/prefs.ts";
import { Frecency } from "../../sidecar/db/frecency.ts";
import { dispatch } from "../../sidecar/ws/rpc.ts";
import { Opencode1Adapter } from "../../sidecar/adapter/opencode1/adapter.ts";
import { StreamBuffers } from "@otk/content";
import { mapPromptParts } from "../../sidecar/adapter/opencode1/prompt.ts";

Deno.test("frecency persists at most 1000 canonical entries across projects", async () => {
  const root = await fixture(), db = new OtkDb(root), store = new Frecency(db);
  try {
    for (let i = 0; i < 1005; i++) {
      store.bump(i % 2 ? "/project-a" : "/project-b", `file-${i}`);
    }
    assertEquals(
      Number(
        db.connection.prepare("SELECT count(*) AS n FROM frecency").get()!.n,
      ),
      1000,
    );
    assert(
      store.list("/project-b").some((row) =>
        row.path === "/project-b/file-1004"
      ),
    );
  } finally {
    db.close();
  }
});

Deno.test("frecency rejects oversized keys before persisting them", async () => {
  const root = await fixture(), db = new OtkDb(root), store = new Frecency(db);
  try {
    assertThrows(() => store.bump("/project", "x".repeat(4097)), Error);
    assertThrows(() => store.list("x".repeat(4097)), Error);
    assertEquals(
      Number(
        db.connection.prepare("SELECT count(*) AS n FROM frecency").get()!.n,
      ),
      0,
    );
  } finally {
    db.close();
  }
});

function adapterFor(root: string) {
  const settings = cfg();
  settings.harness.db = join(root, "missing.db");
  const session = {
    id: "ses_files",
    projectID: "project",
    directory: root,
    title: "Files",
    time: { created: 1, updated: 1 },
  };
  return new Opencode1Adapter(settings, new StreamBuffers(), (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/session/ses_files") {
      return Promise.resolve(Response.json(session));
    }
    assertEquals(url.pathname, "/find/file");
    return Promise.resolve(Response.json(["src/file.ts", "blocked/file.ts"]));
  });
}

Deno.test("frecency RPC uses authoritative session directory instead of a client-claimed project", async () => {
  const root = await fixture(),
    db = new OtkDb(root),
    store = new Frecency(db),
    prefs = new Prefs(db),
    adapter = adapterFor(root);
  try {
    await dispatch(
      adapter,
      "frecency.bump",
      {
        sessionID: "ses_files",
        directory: "/forged-project",
        path: "src/file.ts",
      },
      prefs,
      store,
    );
    assertEquals(store.list("/forged-project"), []);
    assertEquals(store.list(root)[0].path, join(root, "src/file.ts"));
    assertEquals(
      await dispatch(
        adapter,
        "frecency.list",
        { sessionID: "ses_files", directory: "/forged-project" },
        prefs,
        store,
      ),
      store.list(root),
    );
  } finally {
    await adapter.stop();
    db.close();
  }
});

Deno.test("permission-denied stat candidates are no-match in both find and prompt mapping", async () => {
  const root = await fixture();
  await Deno.mkdir(join(root, "src"));
  await Deno.mkdir(join(root, "blocked"));
  await Deno.writeTextFile(join(root, "src/file.ts"), "readable");
  await Deno.writeTextFile(join(root, "blocked/file.ts"), "denied");
  await Deno.chmod(join(root, "blocked"), 0);
  const adapter = adapterFor(root);
  try {
    for (
      const query of [
        "src/file.ts",
        join(root, "src/file.ts"),
        "./src/../src/file.ts",
      ]
    ) {
      const files = await adapter.findFiles("ses_files", query);
      assert(files.some((file) => file.path === query && !file.directory));
      assert(!files.some((file) => file.path === "blocked/file.ts"));
    }
    assertEquals(
      await mapPromptParts([{ kind: "text", text: "keep text" }, {
        kind: "file",
        source: "path",
        path: "blocked/file.ts",
      }], root),
      [{ type: "text", text: "keep text" }],
    );
  } finally {
    await Deno.chmod(join(root, "blocked"), 0o700);
    await adapter.stop();
  }
});

Deno.test("mapped file filenames retain the relative path and optional canonical range", async () => {
  const root = await fixture();
  await Deno.mkdir(join(root, "src"));
  await Deno.writeTextFile(join(root, "src/file.ts"), "one\ntwo\nthree");
  const parts = await mapPromptParts([{
    kind: "file",
    source: "path",
    path: "./src/file.ts",
    range: { start: 3 },
  }], root);
  assertEquals(parts[0].type, "file");
  assertEquals(
    "filename" in parts[0] ? parts[0].filename : undefined,
    "src/file.ts#3",
  );
});
