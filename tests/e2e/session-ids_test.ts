// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { ContentSession } from "@otk/protocol";
import { test } from "../support/resources.ts";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";

test("qualified identities survive native creation, prompt, external helper, cold reload and canonical navigation", async () => {
  const f = await browserFixture({ bash: "allow" });
  let client: WsClient | undefined, older: WsClient | undefined;
  try {
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    const root = await client.rpc<ContentSession>("session.create", {
      directory: f.oc.directory,
      title: "Qualified identity smoke",
    });
    assertMatch(root.id, /^opcv1-ses_[A-Za-z0-9_-]+$/);
    const native =
      (await f.oc.request<{ id: string; title: string }[]>("/session")).find((
        session,
      ) => session.title === root.title)!;
    assertEquals(root.id, `opcv1-${native.id}`);
    await assertRejects(
      () => client!.rpc("session.get", { sessionID: native.id }),
      Error,
      "qualified sessionID",
    );

    const b = await f.browser(server.url);
    await openSession(b, root.id);
    f.fake.queue({ chunks: ["Qualified session reply."] });
    await b.fill(
      'textarea[name="prompt"]',
      "Prove qualified native prompt delivery",
    );
    await b.key("Enter");
    await waitForReply(b, root.id, "Qualified session reply.");

    const child = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { parentID: native.id, title: "Helper created outside OTK" },
    });
    await f.oc.request(`/session/${child.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "External helper transcript." }],
      },
    });
    const helperID = `opcv1-${child.id}`;
    await openSession(b, helperID);
    await b.poll(
      "document.querySelector('.otk-messages')?.textContent.includes('External helper transcript.')",
    );
    assertEquals(
      await b.evaluate("location.hash"),
      `#/local/${root.id}/${helperID}`,
    );
    await b.send("Page.reload", { ignoreCache: true });
    await b.poll(
      "!!document.querySelector('.otk-subagent-bar') && document.querySelector('.otk-messages')?.textContent.includes('External helper transcript.')",
    );
    assertEquals(
      await b.evaluate("location.hash"),
      `#/local/${root.id}/${helperID}`,
    );
    assertEquals(
      (await client.rpc<ContentSession>("session.get", { sessionID: helperID }))
        .parentID,
      root.id,
    );

    await b.goto(`${server.url}/#/local/${root.id}`);
    await waitForReply(b, root.id, "Qualified session reply.");
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(
        `document.documentElement.dataset.otkTheme==='${theme}' && !!document.querySelector('[data-session="${helperID}"]')`,
      );
      const destination = Deno.env.get("OTK_SESSION_ID_SCREENSHOTS");
      if (destination) {
        await b.screenshot(
          join(destination, `${theme}-qualified-sessions.png`),
        );
      }
    }
    await b.goto(`${server.url}/#/local/${native.id}`);
    await b.poll(
      "document.querySelector('.otk-global-error')?.textContent==='This session link is from an older version. Open Sessions to choose a session.'",
    );
    assertEquals(
      sentFrames(b).some(({ frame }) =>
        (frame.params as Record<string, unknown> | undefined)?.sessionID ===
          native.id || frame.sessionID === native.id
      ),
      false,
    );
    await b.goto(`${server.url}/#/local/${root.id}`);
    await waitForReply(b, root.id, "Qualified session reply.");
    const sessionFrames = sentFrames(b).flatMap(({ frame }) => {
      const id = frame.sessionID ??
        (frame.params as Record<string, unknown> | undefined)?.sessionID;
      return typeof id === "string" ? [id] : [];
    });
    assertEquals(
      sessionFrames.every((id) => /^opcv1-[A-Za-z0-9_-]+$/.test(id)),
      true,
    );
    assertEquals(b.errors, []);

    older = new WsClient(server.url);
    await waitFor(() => older!.ws.readyState, (state) => state === 1);
    older.send({ t: "hello", protocol: 13 });
    await older.wait((frame) =>
      frame.t === "error" && frame.code === "protocol"
    );
    assertEquals(older.frames.some((frame) => frame.t === "welcome"), false);
  } finally {
    await older?.close();
    await client?.close();
    await f.stop();
  }
});
