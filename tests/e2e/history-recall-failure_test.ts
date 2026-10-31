// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { WsClient } from "../support/ws-client.ts";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import { test } from "../support/resources.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`deleted recall attachment rejects definitively and preserves the complete draft without native send in ${theme}`, () =>
    deletedRecall(theme));
}
async function deletedRecall(theme: string) {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const source = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Deleted recall source" },
    });
    const target = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Keep recalled draft" },
    });
    await f.oc.request(`/session/${source.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [
          { type: "text", text: "Keep this recalled draft" },
          {
            type: "file",
            filename: "pixel.png",
            mime: "image/png",
            url:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
          },
        ],
      },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "theme", value: theme });
    await browser.poll(
      `document.documentElement.dataset.otkTheme==='${theme}'`,
    );
    await openSession(browser, target.id);
    await browser.poll(
      "document.querySelector('.otk-messages .otk-pane-state .otk-empty')?.textContent==='Start a conversation below.' && !document.querySelector('.otk-composer-notice')",
    );
    await browser.click("textarea[name=prompt]");
    await browser.key("ArrowUp");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='Keep this recalled draft' && document.querySelectorAll('.otk-prompt-chip').length===1",
    );
    await f.oc.request(`/session/${source.id}`, { method: "DELETE" });
    await browser.click(".otk-prompt button[type=submit]");
    await browser.poll(
      "document.querySelectorAll('.otk-composer-notice [role=alert]').length===1",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "Keep this recalled draft",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('.otk-prompt-chip').length",
      ),
      1,
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) =>
        frame.method === "session.prompt"
      ).length,
      0,
    );
    assertEquals(f.fake.requests.length, 0);
    const sent = sentFrames(browser).find(({ frame }) =>
      frame.method === "history.attachments"
    )!;
    const ref = sent.frame.ref as { id: string };
    assertEquals(
      browser.events.filter((event) =>
        event.method === "Network.webSocketFrameReceived"
      ).map((event) =>
        JSON.parse(
          (event.params.response as { payloadData: string }).payloadData,
        )
      ).some((frame) =>
        frame.t === "request.result" && frame.ref.id === ref.id &&
        frame.outcome.ok === false
      ),
      true,
    );
    const shots = Deno.env.get("OTK_HISTORY_SCREENSHOTS");
    if (shots) {
      for (const theme of ["otk-dark", "otk-light"]) {
        await client.rpc("prefs.set", { key: "theme", value: theme });
        await browser.poll(
          `document.documentElement.dataset.otkTheme==='${theme}' && document.querySelectorAll('.otk-composer-notice [role=alert]').length===1`,
        );
        await browser.screenshot(join(shots, `${theme}-missing-recall.png`));
      }
    }
  } finally {
    await client?.close();
    await f.stop();
  }
}
