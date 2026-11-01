// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { scaleParts } from "./message-scale-cases.ts";
import type {
  ScaleManifest,
  ScaleVariant,
  SnapshotManifest,
} from "./session-scale.ts";

function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Unknown or inconsistent fixture ${label}: ${
        JSON.stringify(actual).slice(0, 300)
      }`,
    );
  }
}
function hasRoot(value: unknown, root: string): boolean {
  return typeof value === "string"
    ? value.includes(root)
    : !!value && typeof value === "object" &&
      Object.values(value).some((v) => hasRoot(v, root));
}
function messageShape(data: Record<string, unknown>): void {
  const keys = data.role === "user"
    ? ["role", "time", "agent", "model"]
    : data.role === "assistant"
    ? [
      "role",
      "parentID",
      "time",
      "agent",
      "providerID",
      "modelID",
      "mode",
      "path",
      "tokens",
      "finish",
      ...(Object.hasOwn(data, "cost") ? ["cost"] : []),
    ]
    : [];
  equal(Object.keys(data).sort(), keys.sort(), "message shape");
}
/** Independent SQL population and complete generated source checks, no product mappers. */
export function validateScale(
  path: string,
  manifest: ScaleManifest,
  root: string,
  variant: ScaleVariant,
  filesRoot = root,
) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    equal(
      db.prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all(),
      manifest.schema,
      "schema",
    );
    equal(
      db.prepare("SELECT * FROM migration ORDER BY id").all(),
      manifest.migrations,
      "migrations",
    );
    const count = (sql: string, ...args: string[]) =>
      Number(db.prepare(sql).get(...args)!.n);
    equal({
      sessions: count("SELECT count(*) n FROM session"),
      projectSessions: count(
        "SELECT count(*) n FROM session WHERE directory=?",
        join(root, "project"),
      ),
      projectMessages: count(
        "SELECT count(*) n FROM message WHERE session_id IN (SELECT id FROM session WHERE directory=?)",
        join(root, "project"),
      ),
      largestMessages: count(
        "SELECT count(*) n FROM message WHERE session_id='ses_scale000000'",
      ),
      largestParts: count(
        "SELECT count(*) n FROM part WHERE session_id='ses_scale000000'",
      ),
    }, {
      sessions: 4615,
      projectSessions: 251,
      projectMessages: 27205,
      largestMessages: 1525,
      largestParts: 5672,
    }, "population");
    const sessions = db.prepare("SELECT id,directory FROM session ORDER BY id")
      .all();
    equal(
      sessions.map((s) => [s.id, s.directory]),
      manifest.sessions.map((s) => [s.nativeID, s.directory]),
      "session directories",
    );
    const options = manifest.messageCases ?? {};
    let first = 0;
    for (let i = 0; i < manifest.sessions.length; i++) {
      const session = manifest.sessions[i];
      const rows = db.prepare(
        "SELECT id,data FROM message WHERE session_id=? ORDER BY id",
      ).all(session.nativeID);
      equal(rows.length, session.expected.messages, "message total");
      const usage = {
        messages: rows.length,
        calls: 0,
        cost: 0 as number | null,
        tokens: [0, 0, 0, 0, 0] as (number | null)[],
        turns: {} as ScaleManifest["sessions"][number]["expected"]["turns"],
      };
      for (let m = 0; m < rows.length; m++) {
        const data = JSON.parse(String(rows[m].data));
        messageShape(data);
        if (data.role === "assistant") {
          equal(
            data.path,
            { cwd: session.directory, root: session.directory },
            "assistant paths",
          );
          const values = [
            data.tokens.input ?? null,
            data.tokens.output,
            data.tokens.reasoning,
            data.tokens.cache.read,
            data.tokens.cache.write,
          ];
          const turn = usage.turns[data.parentID] ??= {
            calls: 0,
            cost: 0,
            tokens: [0, 0, 0, 0, 0],
          };
          for (const total of [usage, turn]) {
            total.calls++;
            total.cost = total.cost === null || data.cost === undefined
              ? null
              : total.cost + data.cost;
            values.forEach((v, k) =>
              total.tokens[k] = v === null || total.tokens[k] === null
                ? null
                : total.tokens[k]! + v
            );
          }
        } else if (data.role !== "user") {
          throw new Error("Unknown message role");
        }
      }
      equal(
        usage,
        session.expected,
        "session/turn usage including unknown and zero",
      );
      const parts = db.prepare(
        "SELECT message_id,id,data FROM part WHERE session_id=? ORDER BY message_id,id",
      ).all(session.nativeID);
      equal(
        parts.length,
        i === 0 ? 5672 : rows.length,
        "complete part population",
      );
      for (const part of parts) {
        const rank = Number(String(part.message_id).slice("msg_scale".length)) -
          first;
        const index = Number(String(part.id).split("_").at(-1));
        equal(
          JSON.parse(String(part.data)),
          scaleParts(i, rank, index, session.directory, options),
          "part source",
        );
      }
      first += rows.length;
    }
    if (variant === "remaining-files") {
      for (let n = 0; n < 10000; n++) {
        const path = join(
          filesRoot,
          "project/catalog",
          `group-${String(Math.floor(n / 100)).padStart(2, "0")}`,
          `candidate-${String(n).padStart(5, "0")}.txt`,
        );
        equal(
          Deno.readTextFileSync(path),
          `Private candidate ${n} contents`,
          "file source",
        );
      }
    }
  } finally {
    db.close();
  }
}

/** Revision 1 covers only the characterized four native variants. Unknown paths fail closed. */
export function relocateScale(
  path: string,
  snapshot: SnapshotManifest,
  root: string,
): ScaleManifest {
  if (
    snapshot.relocation !== 1 ||
    !["sessions", "messages", "messages-payload", "remaining-files"].includes(
      snapshot.variant,
    )
  ) throw new Error("Unknown relocation recipe");
  const old = snapshot.originalRoot;
  const map = (value: unknown): string => {
    if (value === join(old, "project")) return join(root, "project");
    if (value === join(old, "background")) return join(root, "background");
    if (value === join(old, "project/scale.ts")) {
      return join(root, "project/scale.ts");
    }
    throw new Error(`Unknown fixture path shape: ${value}`);
  };
  const manifest = structuredClone(snapshot.scale);
  const db = new DatabaseSync(path);
  let transaction = false;
  try {
    equal(
      db.prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all(),
      manifest.schema,
      "schema",
    );
    db.exec("BEGIN IMMEDIATE");
    transaction = true;
    for (const row of db.prepare("SELECT id,worktree FROM project").all()) {
      // Stock's global project is '/' and contains no fixture path.
      if (row.worktree === "/") continue;
      db.prepare("UPDATE project SET worktree=? WHERE id=?").run(
        map(row.worktree),
        row.id,
      );
    }
    for (const row of db.prepare("SELECT id,directory FROM session").all()) {
      db.prepare("UPDATE session SET directory=? WHERE id=?").run(
        map(row.directory),
        row.id,
      );
    }
    for (const row of db.prepare("SELECT id,data FROM message").all()) {
      const data = JSON.parse(String(row.data));
      if (data.role === "assistant") {
        equal(
          Object.keys(data.path).sort(),
          ["cwd", "root"],
          "assistant path shape",
        );
        data.path = { cwd: map(data.path.cwd), root: map(data.path.root) };
      } else if (data.role !== "user") throw new Error("Unknown message shape");
      if (hasRoot(data, old)) throw new Error("Unknown message path field");
      messageShape(data);
      db.prepare("UPDATE message SET data=? WHERE id=?").run(
        JSON.stringify(data),
        row.id,
      );
    }
    for (const row of db.prepare("SELECT id,data FROM part").all()) {
      const data = JSON.parse(String(row.data));
      if (data.type === "tool") {
        if (data.tool === "edit") {
          data.state.input.filePath = map(data.state.input.filePath);
          data.state.metadata.filediff.file = map(
            data.state.metadata.filediff.file,
          );
          // This revision's generated patch headers/output are relative/nonpath.
        } else if (data.tool !== "task") {
          throw new Error("Unknown tool path recipe");
        }
      } else if (data.type !== "text") {
        throw new Error("Unknown part path recipe");
      }
      if (hasRoot(data, old)) throw new Error("Unknown part path field/text");
      db.prepare("UPDATE part SET data=? WHERE id=?").run(
        JSON.stringify(data),
        row.id,
      );
    }
    // Any newly path-bearing schema column requires characterization, not broad replacement.
    for (const table of ["project", "session", "message", "part"]) {
      if (
        db.prepare(`SELECT * FROM ${table}`).all().some((row) =>
          hasRoot(row, old)
        )
      ) throw new Error(`Unrelocated ${table} path`);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (transaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  manifest.directory = map(manifest.directory);
  manifest.db = join(root, "data/opencode/opencode.db");
  for (const session of manifest.sessions) {
    session.directory = map(session.directory);
  }
  return manifest;
}
