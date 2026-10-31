// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";
import { test } from "../support/resources.ts";

test("cold browser recalls image and PDF references and sends exact provider bytes with retained chip order", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  const pdf = btoa("%PDF-1.4\n%%EOF\n");
  try {
    const source = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Provider recall source" },
    });
    const target = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Recalled attachments" },
    });
    await f.oc.request(`/session/${source.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [
          { type: "text", text: "Review the image and [PDF 1]" },
          {
            type: "file",
            filename: "pixel.png",
            mime: "image/png",
            url: `data:image/png;base64,${image}`,
          },
          {
            type: "file",
            filename: "report.pdf",
            mime: "application/pdf",
            url: `data:application/pdf;base64,${pdf}`,
          },
        ],
      },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await openSession(browser, target.id);
    await browser.click("textarea[name=prompt]");
    await browser.key("ArrowUp");
    await browser.poll(
      "document.querySelectorAll('.otk-prompt-chip').length===2 && document.querySelector('textarea[name=prompt]').value.includes('Review the image')",
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) =>
        frame.method === "history.attachments"
      ).length,
      0,
    );
    const shots = Deno.env.get("OTK_HISTORY_SCREENSHOTS");
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      if (shots) {
        await browser.screenshot(join(shots, `${theme}-recalled-files.png`));
      }
    }
    f.fake.queue({ chunks: ["Recalled files received."] });
    await browser.click(".otk-prompt button[type=submit]");
    const rows = await waitFor(
      () =>
        f.oc.request<
          {
            parts: {
              type: string;
              filename?: string;
              mime?: string;
              url?: string;
            }[];
          }[]
        >(`/session/${target.id}/message`),
      (rows) =>
        rows.some((row) => row.parts.some((p) => p.filename === "report.pdf")),
    );
    assertEquals(
      rows.flatMap((r) => r.parts).filter((p) => p.type === "file").map((
        p,
      ) => [p.filename, p.mime, p.url]),
      [
        ["pixel.png", "image/png", `data:image/png;base64,${image}`],
        ["report.pdf", "application/pdf", `data:application/pdf;base64,${pdf}`],
      ],
    );
    await waitForReply(browser, target.id, "Recalled files received.");
    const batches = sentFrames(browser).filter(({ frame }) =>
      frame.method === "history.attachments"
    );
    assertEquals(batches.length, 1);
    assertEquals(
      (batches[0].frame.params as { refs: unknown[] }).refs.length,
      2,
    );
    await browser.poll(
      "!document.querySelector('.otk-prompt-chip') && document.querySelector('textarea[name=prompt]').value===''",
    );
    const state = join(f.oc.root, `otk-${server.port}`);
    for (const name of ["otk.db", "digest.db", "otk.db-wal", "digest.db-wal"]) {
      try {
        const persisted = new TextDecoder().decode(
          await Deno.readFile(join(state, name)),
        );
        for (const content of [image, pdf, "Review the image and [PDF 1]"]) {
          assertEquals(
            persisted.includes(content),
            false,
            `${name} retained provider content`,
          );
        }
      } catch (error) {
        if (
          !name.endsWith("-wal") || !(error instanceof Deno.errors.NotFound)
        ) throw error;
      }
    }
  } finally {
    await client?.close();
    await f.stop();
  }
});

for (const theme of ["otk-dark", "otk-light"]) {
  test(`definitively rejected recall reaches one composer failure instead of successful empty history in ${theme}`, () =>
    rejectedRecall(theme));
}
async function rejectedRecall(theme: string) {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const target = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Unavailable recall" },
    });
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "theme", value: theme });
    const browser = await f.browser(server.url);
    await openSession(browser, target.id);
    // The prompt can mount before its first page installs the stable consumer.
    // Observe that page and settled bookkeeping before injecting a read failure.
    await browser.poll(
      "document.querySelector('.otk-messages .otk-pane-state .otk-empty')?.textContent==='Start a conversation below.' && !document.querySelector('.otk-composer-notice')",
    );
    await browser.evaluate(
      "(()=>{const original=WebSocket.prototype.send;WebSocket.prototype.send=function(data){const frame=JSON.parse(data);if(frame.method==='history.list'){frame.method='fixture.history.unavailable';return original.call(this,JSON.stringify(frame));}return original.call(this,data);}})()",
    );
    await browser.click("textarea[name=prompt]");
    await browser.key("ArrowUp");
    await browser.poll(
      "document.querySelectorAll('.otk-composer-notice [role=alert]').length===1",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('.otk-prompt-chip').length",
      ),
      0,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-composer-notice [role=alert]').textContent.includes('fixture.history.unavailable')",
      ),
      false,
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) =>
        frame.method === "fixture.history.unavailable"
      )
        .length,
      1,
    );
  } finally {
    await client?.close();
    await f.stop();
  }
}
