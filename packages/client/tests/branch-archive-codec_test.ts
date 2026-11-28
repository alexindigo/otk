// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createBranchHistory, createDrafts } from "@otk/client";
import { packBranch, unpackBranch } from "../branch-archive-codec.ts";

Deno.test("archive codec retains arbitrary native JSON keys and nested source-shaped content", () => {
  // Deno removes the legacy accessor; archives are decoded in a browser, where
  // ordinary assignment to __proto__ changes the prototype instead of data.
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "__proto__",
  );
  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    get(this: object) {
      return Object.getPrototypeOf(this);
    },
    set(this: object, value: object | null) {
      Object.setPrototypeOf(this, value);
    },
  });
  try {
    const payload = JSON.parse(
      '{"__proto__":{"text":"Keep this key"},"constructor":"raw","source":{"preview":"{\\"text\\":\\"Keep exact spacing\\"}"}}',
    );
    const value = {
      source: {
        kind: "fixture",
        preview: JSON.stringify(payload),
        bytes: 1,
        truncated: false,
      },
    };
    const saved = unpackBranch(packBranch(value)) as typeof value;
    assertEquals(JSON.parse(saved.source.preview), payload);
    assert(Object.hasOwn(JSON.parse(saved.source.preview), "__proto__"));
    assertEquals(
      JSON.stringify(JSON.parse(saved.source.preview)),
      JSON.stringify(payload),
    );
  } finally {
    if (descriptor) {
      Object.defineProperty(Object.prototype, "__proto__", descriptor);
    } else Reflect.deleteProperty(Object.prototype, "__proto__");
  }
});

Deno.test("archive stores typical revert content once across Source, parts, prompts and drafts", async () => {
  const text = "A typical tool response with retained content.\n".repeat(120);
  const output = { text };
  const values = new Map<string, string>();
  const record = { boundaryID: "p", messageIDs: ["p"], files: [] };
  const session = {
    id: "s",
    title: "Sample",
    directory: "/repo",
    projectID: "p",
    archived: false,
    time: { created: 1, updated: 1 },
    revert: record,
  };
  const owner = createBranchHistory({
    drafts: createDrafts(),
    server: () => "fixture",
    storage: {
      get length() {
        return values.size;
      },
      key: (i) => [...values.keys()][i] ?? null,
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => {
        values.set(k, v);
      },
      removeItem: (k) => {
        values.delete(k);
      },
    },
    session: () => Promise.resolve(session),
    page: () =>
      Promise.resolve({
        sessionID: "s",
        session,
        items: [{
          id: "p",
          sessionID: "s",
          role: "user" as const,
          time: { created: 1 },
          parts: [{
            kind: "text" as const,
            id: "part",
            synthetic: false,
            blocks: [{ b: "code" as const, text }],
            source: { kind: "fixture", ref: "part" },
          }],
          source: { kind: "fixture", ref: "message" },
        }],
        revisions: { p: 0 },
        clock: { epoch: "e", seq: 1 },
        from: { epoch: "e", seq: 1 },
        version: { generation: 0, revision: 0 },
        older: null,
        helpers: {},
        recovering: [],
        catchup: [],
        turns: {},
      }),
    source: () =>
      Promise.resolve({
        kind: "fixture",
        preview: JSON.stringify(output, null, 2),
        bytes: text.length,
        truncated: false,
      }),
    prompt: () =>
      Promise.resolve({
        input: text,
        mode: "normal" as const,
        parts: [],
        time: 1,
      }),
    attachments: (parts) => Promise.resolve(parts),
  });
  const target = { sidecarId: "local", sessionID: "s" };
  owner.select(target);
  await owner.prepare(target, "p", record);
  const raw = [...values.values()][0];
  const key = [...values.keys()][0];
  console.log(
    JSON.stringify({ typicalRevertUTF16Bytes: 2 * (key.length + raw.length) }),
  );
  assertEquals(
    raw.split(JSON.stringify(text)).length - 1,
    1,
    "Canonical content is stored exactly once, not repeated in Source and prompt copies",
  );
  const saved = owner.state.branches[0];
  assert(
    Object.getOwnPropertyDescriptor(saved.messages[0].source, "preview")?.get,
    "The saved Source preview is derived on inspection, not materialized at decode",
  );
  assertEquals(JSON.parse(saved.messages[0].source!.preview!), output);
  assertEquals(saved.prompts[0].entry.input, text);
});
