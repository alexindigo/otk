// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { runTool } from "../support/rendering.ts";
import { WsClient } from "../support/ws-client.ts";
import type { Cdp } from "../support/cdp.ts";

async function capture(b: Cdp, name: string) {
  const destination = Deno.env.get("OTK_SESSION_ACTION_SCREENSHOTS");
  if (destination) await b.screenshot(join(destination, `${name}.png`));
}
test("shared-directory revert follows native file rollback without confirmation and restore recovers the other session's edit", async () => {
  const f = await browserFixture({ edit: "allow", read: "allow" });
  try {
    const a = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Session A" },
    });
    const other = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Session B" },
    });
    const server = await f.sidecar(),
      b = await f.browser(server.url),
      path = join(f.oc.directory, "shared.txt");
    await openSession(b, a.id);
    await runTool(f, b, a.id, {
      name: "write",
      input: { filePath: path, content: "A\n" },
    });
    await openSession(b, other.id);
    await runTool(f, b, other.id, {
      name: "edit",
      input: { filePath: path, oldString: "A", newString: "B" },
    });
    const transcript = await f.oc.request(`/session/${other.id}/message`);
    assertEquals(await Deno.readTextFile(path), "B\n");
    await openSession(b, a.id);
    await b.evaluate("document.querySelector('.otk-user-bubble').focus()");
    await b.click('[data-message-command="prompt.revert"]');
    await b.poll(
      "document.querySelector('.otk-rolled-back-strip strong')?.textContent==='1 prompt rolled back'",
    );
    assertEquals(
      b.events.filter((e) => e.method === "Page.javascriptDialogOpening")
        .length,
      0,
    );
    await assertRejects(() => Deno.readTextFile(path), Deno.errors.NotFound);
    assertEquals(
      await f.oc.request(`/session/${other.id}/message`),
      transcript,
    );
    await b.click(".otk-rollback-disclosure");
    await b.click(".otk-rollback-footer button");
    await b.poll("!document.querySelector('.otk-rolled-back-strip')");
    assertEquals(await Deno.readTextFile(path), "B\n");
    assertEquals(
      await f.oc.request(`/session/${other.id}/message`),
      transcript,
    );
  } finally {
    await f.stop();
  }
});
for (const theme of ["otk-dark", "otk-light"]) {
  test(`revert strip restores files and conversation, survives reload and commits on the next prompt (${theme})`, async () => {
    const f = await browserFixture({ edit: "allow", read: "allow" }, {
      prepare: (oc) =>
        Deno.writeTextFile(join(oc.directory, "revert.txt"), "before\n"),
    });
    let client: WsClient | undefined;
    try {
      const s = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Rollback review" },
      });
      const server = await f.sidecar();
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      const b = await f.browser(server.url);
      await openSession(b, s.id);
      await runTool(f, b, s.id, {
        name: "edit",
        input: {
          filePath: join(f.oc.directory, "revert.txt"),
          oldString: "before",
          newString: "after",
        },
      });
      f.fake.queue({ chunks: ["Second reply."] });
      await b.fill('textarea[name="prompt"]', "Explain the file change");
      await b.key("Enter");
      await waitForReply(b, s.id, "Second reply.");
      const first = '[data-role="user"] [data-message-command="prompt.revert"]';
      await b.evaluate(
        "document.querySelector('[data-role=user]').scrollIntoView({block:'center',behavior:'instant'});document.querySelector('.otk-user-bubble').focus({preventScroll:true})",
      );
      await b.poll(`!!document.querySelector('${first}')`);
      await b.click(first);
      await b.poll(
        "document.querySelector('.otk-rolled-back-strip strong')?.textContent==='2 prompts rolled back' && document.querySelectorAll('[data-message]').length===0",
      );
      assertEquals(
        await Deno.readTextFile(join(f.oc.directory, "revert.txt")),
        "before\n",
      );
      await capture(b, `${theme}-strip-collapsed`);
      assertEquals(
        await b.evaluate(
          "(()=>{const notice=document.querySelector('.otk-composer-notice').getBoundingClientRect(),input=document.querySelector('.otk-composer-input').getBoundingClientRect(),prompt=document.querySelector('.otk-prompt').getBoundingClientRect();return {sameLeft:notice.left===input.left,sameRight:notice.right===input.right,joined:notice.bottom>input.top,promptInside:prompt.top>=input.top}})()",
        ),
        { sameLeft: true, sameRight: true, joined: true, promptInside: true },
      );
      await b.click(".otk-rollback-disclosure");
      await b.poll(
        "document.querySelectorAll('.otk-rollback-prompt').length===2 && document.querySelector('.otk-rollback-details').textContent.includes('revert.txt')",
      );
      await capture(b, `${theme}-strip-expanded`);
      await b.send("Browser.grantPermissions", {
        origin: server.url,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      await b.click(
        '.otk-rollback-prompt [aria-label="Copy rolled-back prompt"]',
      );
      await b.poll(
        "navigator.clipboard.readText().then(text=>text==='Run edit')",
      );
      await b.reload();
      await openSession(b, s.id);
      await b.poll(
        "document.querySelector('.otk-rolled-back-strip strong')?.textContent==='2 prompts rolled back'",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-rollback-disclosure').getAttribute('aria-expanded')",
        ),
        "false",
      );
      await b.click(".otk-rollback-disclosure");
      await b.click(".otk-rollback-footer button");
      await b.poll(
        "!document.querySelector('.otk-rolled-back-strip') && document.querySelectorAll('[data-role=user]').length===2",
      );
      assertEquals(
        await Deno.readTextFile(join(f.oc.directory, "revert.txt")),
        "after\n",
      );
      await b.evaluate(
        "document.querySelector('[data-role=user]').scrollIntoView({block:'center',behavior:'instant'});document.querySelector('.otk-user-bubble').focus({preventScroll:true})",
      );
      await b.click(first);
      await b.poll("!!document.querySelector('.otk-rolled-back-strip strong')");
      f.fake.queue({ chunks: ["New direction."] });
      await b.fill('textarea[name="prompt"]', "Take a new direction");
      await b.key("Enter");
      await waitForReply(b, s.id, "New direction.");
      await b.poll("!document.querySelector('.otk-rolled-back-strip')");
      assertEquals(
        (await f.oc.request<{ info: { role: string } }[]>(
          `/session/${s.id}/message`,
        )).filter((m) => m.info.role === "user").length,
        1,
      );
      assertEquals(
        b.events.filter((e) => e.method === "Page.javascriptDialogOpening")
          .length,
        0,
      );
      assertEquals(b.errors, []);
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}
test("revert pending and error stay joined to the composer and retry clears failure", async () => {
  const f = await browserFixture();
  let release = Promise.withResolvers<void>(), fail = true;
  const proxy = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/revert")) {
        await release.promise;
        if (fail) {
          const sessionID = url.pathname.split("/")[2];
          return Response.json({
            _tag: "SessionBusyError",
            sessionID,
            message: `Session is busy: ${sessionID}`,
          }, { status: 409 });
        }
      }
      url.host = new URL(f.oc.url).host;
      return fetch(new Request(url, request));
    },
  );
  let client: WsClient | undefined;
  try {
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Rollback feedback" },
    });
    await f.oc.request(`/session/${s.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "A prompt to roll back" }],
      },
    });
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.addr.port}` },
    });
    client = new WsClient(server.url);
    await client.connect();
    const b = await f.browser(server.url);
    await openSession(b, s.id);
    await b.evaluate("document.querySelector('.otk-user-bubble').focus()");
    await b.click('[data-message-command="prompt.revert"]');
    await b.poll(
      "document.querySelector('.otk-rollback-status')?.textContent==='Rolling back…'",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(b, `${theme}-strip-pending`);
    }
    release.resolve();
    await b.poll(
      "document.querySelector('.otk-rolled-back-strip [role=alert]')?.textContent==='The session is working. Try again when it finishes.'",
    );
    assertEquals(
      await b.evaluate("document.querySelectorAll('[data-role=user]').length"),
      1,
    );
    const geometry = (selector: string) =>
      b.evaluate<
        {
          row: number;
          notice: number;
          textOffset: number;
          icon: number[] | null;
          iconOffset: number | null;
        }
      >(`(()=>{
      const row=document.querySelector(${
        JSON.stringify(selector)
      }),text=row.querySelector('.otk-composer-notice-content')||row.querySelector('strong')||row,icon=row.querySelector(':scope > svg');
      const r=row.getBoundingClientRect(),t=text.getBoundingClientRect(),i=icon?.getBoundingClientRect();
      return {row:r.height,notice:document.querySelector('.otk-composer-notice').getBoundingClientRect().height,textOffset:(t.top+t.height/2)-(r.top+r.height/2),icon:i?[i.width,i.height]:null,iconOffset:i?(i.top+i.height/2)-(r.top+r.height/2):null};
    })()`);
    const errorRows = new Map<string, Awaited<ReturnType<typeof geometry>>>();
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      errorRows.set(
        theme,
        await geometry(".otk-rolled-back-strip [role=alert]"),
      );
      await capture(b, `${theme}-strip-error`);
    }
    fail = false;
    release = Promise.withResolvers<void>();
    release.resolve();
    await b.evaluate("document.querySelector('.otk-user-bubble').focus()");
    await b.click('[data-message-command="prompt.revert"]');
    await b.poll(
      "document.querySelector('.otk-rolled-back-strip strong')?.textContent==='1 prompt rolled back' && !document.querySelector('.otk-rolled-back-strip [role=alert]') && !document.querySelector('.otk-rollback-status')",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      const errorGeometry = errorRows.get(theme)!,
        collapsedGeometry = await geometry(".otk-rollback-disclosure");
      assertEquals(
        errorGeometry.row,
        collapsedGeometry.row,
        "Error and collapsed notice rows must have equal height",
      );
      assertEquals(
        errorGeometry.notice,
        collapsedGeometry.notice,
        "The shared notice frame must not retain paragraph margins",
      );
      assertEquals(
        errorGeometry.icon,
        collapsedGeometry.icon,
        "The leading icon slot must match",
      );
      assertEquals(errorGeometry.icon, [16, 16]);
      assertEquals(
        Math.abs(errorGeometry.textOffset) < 0.5,
        true,
        "Error text must be vertically centred",
      );
      assertEquals(
        Math.abs(collapsedGeometry.textOffset) < 0.5,
        true,
        "Collapsed text must be vertically centred",
      );
      assertEquals(errorGeometry.iconOffset, 0);
      console.info(
        "NOTICE_ROW_GEOMETRY",
        theme,
        JSON.stringify({ error: errorGeometry, collapsed: collapsedGeometry }),
      );
    }
    assertEquals(b.errors, []);
  } finally {
    release.resolve();
    await client?.close();
    await f.stop();
    await proxy.shutdown();
  }
});
