// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { literal, nodes, parse } from "./syntax.ts";

function literalWorker(source: string): boolean {
  return [...nodes(parse(source))].some((node) => {
    if (
      node.type !== "NewExpression" || node.callee.type !== "Identifier" ||
      node.callee.name !== "Worker"
    ) return false;
    const url = node.arguments[0], options = node.arguments[1];
    if (
      url?.type !== "NewExpression" || url.callee.type !== "Identifier" ||
      url.callee.name !== "URL" || literal(url.arguments[0]) !== "./worker.ts"
    ) return false;
    const base = url.arguments[1];
    return base?.type === "MemberExpression" && !base.computed &&
      base.object.type === "MetaProperty" &&
      base.object.meta.name === "import" &&
      base.object.property.name === "meta" &&
      base.property.type === "Identifier" && base.property.name === "url" &&
      options?.type === "ObjectExpression" &&
      options.properties.some((property) =>
        property.type === "ObjectProperty" &&
        property.key.type === "Identifier" && property.key.name === "type" &&
        literal(property.value) === "module"
      );
  });
}

function forbiddenNative(sql: string): boolean {
  return /\bSELECT\s+(?:\w+\.)?(?:data|\*)\s+FROM\s+(?:message|part)\b/i.test(
    sql,
  ) || /FROM\s+part\b[^;]*\bmessage_id\s*=\s*\?/i.test(sql);
}
Deno.test("digest SQL allowlists scalar metadata and batches tool detail", () => {
  const source = Deno.readTextFileSync(
    new URL("../../packages/harness-opencode-v1/digest-db.ts", import.meta.url),
  );
  assertEquals(forbiddenNative(source), false);
  assertEquals(
    forbiddenNative("SELECT data FROM message WHERE session_id=?"),
    true,
  );
  assertEquals(forbiddenNative("SELECT m.* FROM message m"), true);
  assertEquals(forbiddenNative("SELECT id FROM part WHERE message_id=?"), true);
  for (
    const path of [
      "../../packages/harness-opencode-v1/digest-migrations/001.sql",
      "../../packages/harness-opencode-v1/digest-migrations/002.sql",
      "../../packages/store/features/migrations/digest/001.sql",
      "../../packages/store/features/migrations/digest/002.sql",
    ]
  ) {
    const schema = Deno.readTextFileSync(new URL(path, import.meta.url));
    assertEquals(
      /\b(?:body|parts|payload|prompt|text|tool_input|tool_output)\s+(?:TEXT|BLOB|JSON)\b/i
        .test(schema),
      false,
    );
  }
});
Deno.test("provider-private helper checkpoints stay behind the native sink", () => {
  const privateSQL = (source: string) => /\bopcv1_[a-z_]+\b/.test(source);
  const worker = Deno.readTextFileSync(
    new URL("../../core/digest/worker.ts", import.meta.url),
  );
  assertEquals(privateSQL(worker), false);
  assertEquals(
    privateSQL("sql.prepare('SELECT dirty FROM opcv1_helper_scan')"),
    true,
  );
});
Deno.test("digest SQLite connections belong to the worker, not its serving bridge", () => {
  const bridge = Deno.readTextFileSync(
    new URL("../../core/digest/bridge.ts", import.meta.url),
  );
  assertEquals(
    /node:sqlite|new\s+(?:DigestDb|DigestStore|OpencodeV1DigestSink)\s*\(/.test(
      bridge,
    ),
    false,
  );
  assertEquals(literalWorker(bridge), true);
  assertEquals(
    literalWorker(
      'new Worker(\nnew URL("./worker.ts", import.meta.url),\n{type:"module"}\n)',
    ),
    true,
  );
  assertEquals(
    literalWorker(
      'new Worker(new URL(path, import.meta.url), {type:"module"})',
    ),
    false,
  );
  assertEquals(
    literalWorker(
      '// new Worker(new URL("./worker.ts", import.meta.url), {type:"module"})',
    ),
    false,
  );
  assertEquals(
    /node:sqlite|new\s+(?:DigestDb|DigestStore)\s*\(/.test(
      "new DigestDb(path)",
    ),
    true,
  );
});
