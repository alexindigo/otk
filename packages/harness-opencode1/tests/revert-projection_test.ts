// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { Opencode1Adapter } from "../adapter.ts";
import { tempDir, test } from "../../../tests/support/resources.ts";
for (const sql of [true, false]) {
  test(`revert projection bounds oldest previews and shares metadata-only history mapping (${sql ? "SQL" : "API"})`, async () => {
    const db = join(await tempDir("revert-projection-"), "native.db");
    const messages = Array.from({ length: 55 }, (_, i) => {
      const id = `msg_${String(i).padStart(4, "0")}`;
      return {
        info: {
          id,
          sessionID: "source",
          role: "user",
          agent: "build",
          time: { created: i + 1 },
        },
        parts: [
          {
            id: `part_${i}a`,
            messageID: id,
            sessionID: "source",
            type: "text",
            text: i === 0
              ? "Boundary\n  prompt " + "x".repeat(250)
              : `Prompt ${i}`,
          },
          ...(i === 0
            ? [{
              id: "part_0b",
              messageID: id,
              sessionID: "source",
              type: "file",
              filename: "image.png",
              mime: "image/png",
              url: "data:image/png;base64,YWJj",
            }]
            : []),
        ],
      };
    });
    if (sql) {
      await Deno.copyFile(
        new URL(
          "../../../tests/fixtures/opencode1/history-1.18.34-v4.db",
          import.meta.url,
        ),
        db,
      );
      const writer = new DatabaseSync(db);
      writer.exec("BEGIN");
      writer.prepare(
        "INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) SELECT 'source',project_id,'source',directory,'Source',version,time_created,time_updated FROM session LIMIT 1",
      ).run();
      for (const m of messages) {
        writer.prepare(
          "INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)",
        ).run(
          m.info.id,
          "source",
          m.info.time.created,
          1,
          JSON.stringify(m.info),
        );
        for (const p of m.parts) {
          writer.prepare(
            "INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)",
          ).run(p.id, m.info.id, "source", 1, 1, JSON.stringify(p));
        }
      }
      writer.exec("COMMIT");
      writer.close();
    }
    const bytes = sql ? await Deno.readFile(db) : undefined;
    let pages = 0;
    const adapter = new Opencode1Adapter(
      {
        harness: {
          url: "http://fixture",
          username: "",
          password: "",
          db,
          heartbeattimeout: 25,
          reconnectmax: 30,
        },
        index: { days: 30 },
      },
      undefined,
      (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/session/source") {
          return Promise.resolve(
            Response.json({
              id: "source",
              projectID: "p",
              directory: "/project",
              title: "Source",
              time: { created: 1, updated: 99 },
              revert: { messageID: "msg_0000" },
            }),
          );
        }
        pages++;
        assert(url.pathname.startsWith("/session/source/message"));
        if (url.pathname.endsWith("/msg_0000")) {
          return Promise.resolve(Response.json(messages[0]));
        }
        const limit = Number(url.searchParams.get("limit"));
        assert(limit > 0 && limit <= 200);
        return Promise.resolve(Response.json(messages));
      },
    );
    try {
      const revert = (await adapter.core.getSession("source")).revert!;
      assertEquals(revert.messageCount, 55);
      assertEquals(revert.prompts?.length, 50);
      assertEquals(revert.prompts?.[0].messageID, "msg_0000");
      assertEquals(
        revert.prompts?.[0].preview,
        ("Boundary prompt " + "x".repeat(250)).slice(0, 200),
      );
      assertEquals(revert.prompts?.at(-1)?.preview, "Prompt 49");
      assertEquals(revert.prompt?.input, messages[0].parts[0].text);
      assertEquals(revert.prompt?.parts[1], {
        kind: "file",
        source: "history",
        name: "image.png",
        mime: "image/png",
        size: 3,
        messageID: "msg_0000",
        partID: "part_0b",
      });
      assertEquals(JSON.stringify(revert).includes("YWJj"), false);
      if (sql) assertEquals(pages, 0);
    } finally {
      await adapter.core.stop();
    }
    if (bytes) assertEquals(await Deno.readFile(db), bytes);
  });
}
