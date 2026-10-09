// SPDX-License-Identifier: LGPL-3.0-only
// Explicit fixture capture, run once inside the named OTK VM before history gates.
import { assertEquals } from "@std/assert";
import { FakeLlm } from "./fake-llm.ts";
import { OpencodeTest } from "./opencode.ts";
import { DatabaseSync } from "node:sqlite";
import { fromFileUrl } from "@std/path";
import { History } from "../../sidecar/history/history.ts";
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
Deno.test("capture prompt history fixture from real opencode 1.18.34", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  let stopped = false;
  try {
    assertEquals(
      (await oc.request<{ version: string }>("/global/health")).version,
      "1.18.34",
    );
    const a = await oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "History fixture A" },
      }),
      b = await oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "History fixture B" },
      });
    for (const text of ["history first", "history first"]) {
      await oc.request(`/session/${a.id}/message`, {
        method: "POST",
        body: { noReply: true, parts: [{ type: "text", text }] },
      });
    }
    await oc.request(`/session/${b.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "inspect @explore [Image 1]" }, {
          type: "agent",
          name: "explore",
        }, {
          type: "file",
          mime: "image/png",
          filename: "pixel.png",
          url: "data:image/png;base64," + pixel,
        }],
      },
    });
    await oc.request(`/session/${a.id}/shell`, {
      method: "POST",
      body: { agent: "build", command: "echo history-shell" },
    });
    await oc.request(`/session/${b.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "history newest" }],
      },
    });
    const destination = new URL(
        "../fixtures/opencode1/history-1.18.34-v4.db",
        import.meta.url,
      ),
      fresh = oc.root + "/history-snapshot.db";
    const snapshot = await new Deno.Command("/usr/bin/sqlite3", {
      args: [
        "-readonly",
        oc.db,
        `VACUUM INTO '${fresh.replaceAll("'", "''")}'`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      snapshot.success,
      true,
      new TextDecoder().decode(snapshot.stderr),
    );
    const captured = new DatabaseSync(fresh, { readOnly: true });
    try {
      assertEquals(
        captured.prepare(
          "SELECT COUNT(*) AS n FROM message WHERE json_extract(data,'$.role')='user'",
        ).get()!.n,
        5,
      );
    } finally {
      captured.close();
    }
    await oc.stop();
    stopped = true;
    const newReader = new History(fresh),
      projection = newReader.list().map(({ time: _time, ...entry }) => entry);
    newReader.close();
    try {
      await Deno.stat(destination);
      const existing = new History(fromFileUrl(destination));
      try {
        assertEquals(
          existing.list().map(({ time: _time, ...entry }) => entry),
          projection,
        );
      } finally {
        existing.close();
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        await Deno.copyFile(fresh, destination);
      } else throw error;
    }
    console.info(
      "Captured stock history DB:",
      destination.pathname,
      "source:",
      oc.db,
    );
  } finally {
    if (!stopped) await oc.stop();
    await fake.stop();
  }
});
